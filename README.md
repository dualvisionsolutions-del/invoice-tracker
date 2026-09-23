# JobProof — text-a-link job checklists

You text a crew member a link. They open it on their phone — no app, no login, no
password. They work down the checklist, and it makes them take the photos as they
go. They can't turn the job in until every required item is done. The moment they
do, it lands on your board and you get a text.

Built for the water-line problem: *"we have to have pictures of the beginning,
middle and end, and if you don't do it, it makes us look very bad."*

---

## How it stops the failure

| The failure | What the app does |
|---|---|
| "I'll take the photos later" | Later never comes. Steps unlock **in order** — the backfill step won't open until the open-trench photos are in. Once the hole is closed, that evidence is gone forever, so the app refuses to let them get there without it. |
| "I did it, I just didn't write it down" | The **Turn in this job** button stays dead until every required item is satisfied. This is enforced on the server, not just hidden in the app — nobody gets around it by fiddling with their phone. |
| Photos taken from the truck at 5pm | Every photo is stamped with the time it was taken and the GPS location. If all sixteen photos were shot in the same 90 seconds, or came out of the camera roll instead of the camera, the job gets flagged on your board. |
| "Nobody told me what to shoot" | Each step carries the instruction: *"Put a tape measure in the shot showing depth to top of pipe."* For the AFTER photo, their own BEFORE photo is shown right there so they match the angle. |
| Bad signal at the job site | Photos are compressed on the phone (a 9 MB photo becomes ~250 KB) and queued. If signal drops, they keep working — the queue is saved on the phone and sends itself when service comes back. Closing the page warns them first. |
| "He said he'd get to it" | Any job sitting untouched past your cutoff texts you on its own. |
| Built to the wrong spec | Where you've entered your jurisdiction's requirements, a measurement that misses them fails on the spot, locks everything below it, and texts you while the hole is still open. See **Code rules** below — the numbers are yours to enter, not the app's to guess. |

## The six checklists it ships with

Water Line Installation · Sewer Lateral / Tap · Excavation & Backfill ·
Equipment Drop-off / Pick-up · Daily Machine Walk-Around · Final Site Walk & Close-out

All six are starting points, not gospel — edit every step, or build your own, in
**Checklists**. The water line one requires 11 photos across before/during/after.

---

## Getting it running

You need Node 20 or newer. There are no dependencies to install.

```bash
cp .env.example .env      # then open .env and set ADMIN_PASSWORD
npm start
```

Open http://localhost:3000 and sign in with the password you set.

To confirm everything works end to end — including that an unfinished job really
can't be turned in:

```bash
npm test
```

### Putting it where your crew can reach it

Localhost only works on your own computer. Your guys need a real web address.
Any host that runs Node works — Render, Railway, Fly.io, or a $6/month VPS.
Two things matter:

1. **Set `PUBLIC_URL`** to the address your crew will hit, e.g.
   `https://jobs.dualvisionsolutions.com`. The links you text are built from
   this. Get it wrong and the links won't open.
2. **Keep the `data/` folder on a real disk** (a "persistent volume" or "disk"
   on most hosts). That folder is the entire system — jobs, checklists, photos.
   Hosts that wipe the filesystem on every deploy will eat your photos.

---

## Texting the link

**Out of the box, no setup:** after you create a job you get a
**"Open Messages with it typed out"** button. It opens your own phone's texting
app with the message and link already written. You hit send. Costs nothing.

**Automatic, about $1/month + ~1¢ a text:** put Twilio credentials in `.env`
(`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`). Now the app sends the
links itself, sends reminders, and texts **you** at `OWNER_PHONE` the moment a job
is turned in.

**Without Twilio you still get alerts** — set `NOTIFY_WEBHOOK_URL` to a Zapier or
Make webhook and every event (started, submitted, overdue) is posted there as
JSON. Point that at whatever you want: a text, an email, a spreadsheet row.

---

## Your day with it

1. **Jobs → + New job.** Pick the checklist, pick the guy, type the address. 20 seconds.
2. **Send it.** Text button, or it sends itself.
3. **Watch the board.** Every job shows a live progress bar as photos come in. You
   can see he's on step 7 without calling him.
4. **Review.** When it's turned in you get a text. Open it, look at the photos, hit
   **Approve** — or **Send back** with a note, which re-opens it on his phone and
   texts him what's missing.
5. **Send the customer the report.** Every job has a clean shareable page with the
   before/after photos side by side, timestamps, and map links. Prints to PDF. No
   phone numbers or crew links on it — safe to hand to a customer, an inspector,
   or a lawyer.

---

## Code rules

A job can be tied to a jurisdiction — a state, a county, or a city. The rules on
file for that jurisdiction get written into the checklist when you assign the
job, and from then on they ride along with it.

A rule can do two things:

- **Hang a limit on a step you already have.** The water line checklist already
  asks for depth to top of pipe. A minimum-cover rule turns that same box into a
  check: type 36 when your county requires 48 and the step goes red, the steps
  below it stay locked, and the job cannot be turned in.
- **Add a step of its own.** "Inspection passed — cleared to backfill", placed
  immediately before the backfill steps, so the trench cannot be closed until
  it's ticked.

### Nothing enforces until you confirm it

**Every rule ships blank.** The starter set names the subjects that jurisdictions
regulate for underground work and tells you where to find each number — it does
not tell you what the number is.

That is deliberate. Plumbing code is whichever edition your state adopted, plus
whatever your county and city amended on top of it. Nobody can guess that from
the outside, and a wrong number carrying the app's authority is worse than no
number at all — your guy would build to a wrong spec and the app would tell him
he was right.

So until a person fills in the value, pastes the citation, and puts their name on
it, a rule:

- is invisible to the crew as a requirement
- blocks nothing
- never appears on a customer report

Confirming a rule records who confirmed it, when, and how they checked. Change
the value or the citation later and the sign-off is cleared automatically — it
has to be confirmed again before it enforces.

### The measurement is always recorded

If the required cover is 48 inches and your guy measures 36, the app **saves 36**.
It does not refuse the number and it does not ask him to change it. What it does
is mark the step as failing, keep the steps below it locked, block the job from
being turned in, and text you immediately — while the trench is still open and
it is cheap to fix.

### Variances

A hard block with no way out teaches crews to type a passing number. So there's
an honest alternative: **"Can't meet this — tell the office why."** He writes the
reason, you get a text, and you approve or deny it from the job. An approved
variance unblocks the step, and the reason appears on the finished report rather
than disappearing. A denial leaves the job blocked.

### On a finished job

The report carries a code compliance table: each rule, what was measured, whether
it met the requirement, the citation, and the text of any variance you approved.
That's the page to hand an inspector.

Rules are frozen into a job when it's assigned, so editing a rule next year never
rewrites what an old job was worked under.

**None of this is legal advice, and confirming a rule in this app is not the same
as being right about it.** It records what you decided and when. The code is still
whatever your jurisdiction says it is.

## The flags on a submitted job

These are signals worth a look, not accusations:

- **All photos in one burst** — every photo shot within a few minutes on a job that
  ran all day. That's a rebuild after the fact, not a record of the work.
- **From the camera roll** — the file's own timestamp predates the job, so it was
  picked from the gallery rather than taken on site.
- **Taken off site** — a photo more than 500 m from where the rest were taken.
- **No location** — location services were off or denied on that phone.

## Backups

The whole system is the `data/` folder. Copy it and you've copied everything.

```bash
npm run backup          # makes backups/jobproof-<date>.tar.gz
```

Put a copy somewhere that isn't this server. If you ever need to restore, drop the
folder back and start the app.

---

## Worth knowing

- **Job links are unguessable but they aren't passwords.** Anyone the link is
  forwarded to can fill in that one job. That's the trade for "no login" — which is
  the whole reason your guys will actually use it. Photos can only be viewed
  through the job link, the report link, or your signed-in dashboard.
- **Storage is a single JSON file plus photo files.** Simple, easy to back up, and
  fine into the thousands of jobs. Past that it wants a real database.
- **Editing a checklist never changes jobs already sent out.** Each job keeps a
  frozen copy of the checklist as it was when you assigned it, so history stays
  honest.
- **One password for the office.** Everyone in the office shares it. There are no
  per-user accounts.

## Layout

```
server.js               routing, sessions, static files, the overdue timer
src/store.js            the data folder: atomic writes, photo files
src/jobs.js             completion rules, step gating, the integrity flags
src/api.js              every endpoint's actual work
src/seed-templates.js   the six starter checklists — plain data, edit freely
src/codes.js            code rules: matching, enforcement, the verification rule
src/seed-codes.js       starter code subjects — blank values, with lookup hints
src/notify.js           Twilio, webhooks, the wording of every message
public/worker.js        the phone app: camera, compression, offline queue
public/dashboard.js     your board
public/report.js        the customer-facing report
scripts/smoke-test.js   end-to-end proof the checklist rules hold  (npm test)
scripts/code-test.js    end-to-end proof the code rules hold      (npm test)
```
