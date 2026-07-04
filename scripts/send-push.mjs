// Enviador de avisos de "Mi semana". Corre cada ~10 min via GitHub Actions.
// Lee el estado de cada usuario en Firestore, decide qué avisos tocan y los manda por Web Push.
import admin from "firebase-admin";
import webpush from "web-push";

const TZ = "America/Argentina/Buenos_Aires";
const WINDOW = 30; // minutos de tolerancia (el cron puede llegar tarde)

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@lifpoker.com",
  process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

// ---- fecha/hora en Argentina ----
function nowAR(){
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const g = t => parts.find(x => x.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, minutes: +g("hour") * 60 + +g("minute") };
}
const toMin = hhmm => { const [h, m] = String(hhmm || "0:0").split(":"); return (+h) * 60 + (+m); };
const inWindow = (target, now) => now >= target && now < target + WINDOW;

// ---- lógica de agenda (espejo de la app) ----
const pad = n => (n < 10 ? "0" : "") + n;
const dstr = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const fromStr = s => { const p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); };
function startOfWeek(d){ const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0,0,0,0); return x; }
const weeksDiff = (anchorStr, weekStart) => Math.round((weekStart - fromStr(anchorStr)) / (7 * 86400000));
function occursFixed(f, d){
  if(f.dow !== d.getDay()) return false;
  if(f.freq === "2w") return Math.abs(weeksDiff(f.anchor, startOfWeek(d))) % 2 === 0;
  return true;
}
function agendaFor(state, dateS){
  const d = fromStr(dateS);
  const fx = (state.fixed || []).filter(f => occursFixed(f, d));
  const rd = (state.radar || []).filter(r => r.date === dateS && !r.done);
  return fx.concat(rd).sort((a, b) => ((a.time || "99:99") > (b.time || "99:99") ? 1 : -1));
}

async function sendAll(subs, payload, docRef){
  const body = JSON.stringify(payload);
  for(const [key, s] of Object.entries(subs)){
    try {
      await webpush.sendNotification(JSON.parse(s.sub), body);
    } catch(e){
      if(e.statusCode === 404 || e.statusCode === 410){
        await docRef.update({ [`subs.${key}`]: admin.firestore.FieldValue.delete() }).catch(() => {});
        delete subs[key];
      } else console.error("push error", e.statusCode || e.message);
    }
  }
}

const { date: today, minutes: nowMin } = nowAR();
const usersSnap = await db.collection("users").get();

for(const docSnap of usersSnap.docs){
  const d = docSnap.data();
  if(!d.json || !d.subs || !Object.keys(d.subs).length) continue;
  let state;
  try { state = JSON.parse(d.json); } catch(e){ continue; }
  const N = state.notif || {};
  const sent = d.sent || {};
  const newSent = {};
  // conservar claves de hoy y ayer, tirar el resto
  for(const k of Object.keys(sent)) if(k.includes(today) || k.includes(dstr(new Date(fromStr(today) - 86400000)))) newSent[k] = sent[k];
  const subs = d.subs;
  const out = [];

  const agenda = agendaFor(state, today);

  // 1) resumen de la mañana (agenda + radar + pendientes)
  if(N.digest !== false && inWindow(toMin(N.digestTime || "08:00"), nowMin) && !newSent["digest-" + today]){
    const lines = agenda.slice(0, 6).map(it => (it.time ? it.time + " " : "· ") + it.text);
    const open = (state.tasks || []).filter(t => !t.done).length;
    const prios = (state.prios || {})[today] || [];
    let body = lines.length ? lines.join("\n") : "Día libre de agenda.";
    if(prios.length) body += "\nTres cosas: " + prios.map(p => p.text).join(", ");
    else if(open) body += "\n" + open + " pendiente" + (open > 1 ? "s" : "") + " en la lista";
    out.push({ title: "Tu día de hoy", body, tag: "digest" });
    newSent["digest-" + today] = 1;
  }

  // 2) recordatorios antes de cada evento con hora
  if(N.remind !== false){
    const before = +N.remindMin || 30;
    for(const it of agenda){
      if(!it.time) continue;
      const k = "rem-" + today + "-" + it.id;
      if(newSent[k]) continue;
      if(inWindow(toMin(it.time) - before, nowMin)){
        out.push({ title: "En " + before + " min: " + it.text, body: "A las " + it.time, tag: "rem-" + it.id });
        newSent[k] = 1;
      }
    }
  }

  // 3) empujón de hábitos
  if(N.habits !== false && inWindow(toMin(N.habitsTime || "21:00"), nowMin) && !newSent["hab-" + today]){
    const hlog = (state.habitLog || {})[today] || {};
    const missing = (state.habits || []).filter(h => !hlog[h.id]).map(h => h.text);
    if(missing.length && missing.length < (state.habits || []).length + 1 && (state.habits || []).length){
      out.push({ title: "Hábitos de hoy", body: "Te quedan: " + missing.join(", ") + ". Sin culpa, si querés.", tag: "habits" });
    }
    newSent["hab-" + today] = 1;
  }

  for(const p of out) await sendAll(subs, p, docSnap.ref);
  if(out.length || Object.keys(newSent).length !== Object.keys(sent).length){
    await docSnap.ref.update({ sent: newSent }).catch(() => {});
  }
}
console.log("listo", today, nowMin);
