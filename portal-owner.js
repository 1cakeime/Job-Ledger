/* Customer page, contractor side. Loaded after index.html's main script and uses its helpers.
   Kept in its own file so it can be worked on without editing index.html at the same time.

   Each job can have a customer page: j.portal = {token, items:[...]}. An item is either
   - a milestone: something the contractor will get done by a date, or
   - a pick: something the customer has to choose by a deadline (tile color, door style, trees).
   Items carry a description, price, photos, files, a voice memo and, for picks, the options.
   The page is published as a snapshot to customer_portals and opened at portal.html#<token>.
   The customer's picks come back through portal_choices (see portalsPull). */

const PORTAL_BUCKET = "portal";
const portalUrl = (j) => SITE_URL + "portal.html#" + j.portal.token;
const portalFileUrl = (path) =>
  SB_URL +
  "/storage/v1/object/public/" +
  PORTAL_BUCKET +
  "/" +
  path.split("/").map(encodeURIComponent).join("/");
const portalItems = (j) =>
  [...(j.portal?.items || [])].sort(
    (a, b) =>
      (a.date || "9999").localeCompare(b.date || "9999") ||
      a.title.localeCompare(b.title),
  );
const portalPickLabel = (p) => (p ? p.label || p.note || "Answered" : "");

function portalBadge(it) {
  if (it.kind === "milestone")
    return it.done
      ? '<span class="badge done">Done</span>'
      : '<span class="badge">Milestone</span>';
  if (it.pick) return '<span class="badge done">Picked</span>';
  if (it.date && it.date < today())
    return '<span class="badge bad">Late</span>';
  return '<span class="badge active">Waiting</span>';
}

function portalCard(j) {
  if (isEmp()) return "";
  const items = portalItems(j),
    waiting = items.filter((i) => i.kind === "pick" && !i.pick);
  const extras = (it) =>
    [
      it.price !== "" && it.price != null ? money2(num(it.price)) : "",
      (it.files || []).length
        ? `${it.files.length} attachment${it.files.length > 1 ? "s" : ""}`
        : "",
      it.voice ? "voice memo" : "",
    ].filter(Boolean);
  return `<div class="card"><div class="card-head"><h2>Customer page</h2><div class="btns"><button class="btn sm" data-act="portal-new" data-kind="milestone">+ Milestone</button><button class="btn sm primary" data-act="portal-new" data-kind="pick">+ Customer pick</button></div></div>
    ${
      items.length
        ? `<ul class="list">${items
            .map(
              (
                it,
              ) => `<li class="click" data-act="portal-edit" data-id="${it.id}"><div class="grow"><b>${esc(it.title)}</b>
        <small>${it.kind === "pick" ? (it.pick ? "Picked: " + esc(portalPickLabel(it.pick)) : it.date ? "Decide by " + fmtDate(it.date) : "No deadline") : it.date ? fmtDate(it.date) : "No date"}${extras(it).length ? " · " + extras(it).join(" · ") : ""}</small></div>${portalBadge(it)}</li>`,
            )
            .join("")}</ul>
      <div class="split" style="margin-top:10px"><span class="note">${waiting.length ? `Waiting on the customer for ${waiting.length} pick${waiting.length > 1 ? "s" : ""}` : "Nothing waiting on the customer"}${j.portal?.viewedAt ? " · opened " + fmtDate(ds(new Date(j.portal.viewedAt))) : ""}</span>
        <div class="btns">${j.portal?.token ? '<button class="btn sm" data-act="portal-preview">Preview</button>' : ""}<button class="btn sm primary" data-act="portal-send">Send to customer</button></div></div>
      <div id="portal-send-box"></div>`
        : '<p class="note">One simple page for the customer: the dates that matter and the choices they need to make, like tile color or door style, each with a deadline. They open a link, no account needed, and you get a notification when they pick.</p>'
    }</div>`;
}

/* ----- publishing ----- */
function portalSnapshot(j) {
  const p = S.profile || {},
    c = j.customerId ? cust(j.customerId) : null;
  return {
    jobName: j.name || "",
    address: j.address || "",
    client: (c?.name || j.client || "").split(" ")[0],
    company: {
      company: p.company || "",
      name: p.name || "",
      logo: p.logo || "",
      phone: p.phone || "",
      email: p.email || "",
    },
    items: portalItems(j).map((it) => ({
      id: it.id,
      kind: it.kind,
      title: it.title,
      date: it.date || "",
      desc: it.desc || "",
      price: it.price === "" || it.price == null ? null : num(it.price),
      done: it.kind === "milestone" ? !!it.done : undefined,
      locked: it.kind === "pick" ? !!it.locked : undefined,
      files: (it.files || []).map((f) => ({
        path: f.path,
        name: f.name,
        type: f.type,
      })),
      voice: it.voice
        ? { path: it.voice.path, type: it.voice.type, sec: it.voice.sec }
        : null,
      options:
        it.kind === "pick"
          ? (it.options || []).map((o) => ({
              id: o.id,
              label: o.label,
              price: o.price === "" || o.price == null ? null : num(o.price),
              img: o.img || "",
              files: (o.files || []).map((f) => ({ path: f.path, name: f.name, type: f.type })),
            }))
          : undefined,
    })),
  };
}
function portalEnsure(j) {
  if (!j.portal) j.portal = { items: [] };
  if (!j.portal.token) {
    const r = crypto.getRandomValues(new Uint8Array(18));
    j.portal.token = [...r]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  }
  if (!j.portal.code) {
    // Same alphabet as crew invite codes: no 0/O or 1/I to mix up when typing.
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r = crypto.getRandomValues(new Uint8Array(8));
    j.portal.code = [...r].map((x) => A[x % A.length]).join("");
  }
  return j.portal;
}
async function portalPublish(j) {
  if (!isOwnerCloud()) throw new Error("Sign in first");
  portalEnsure(j);
  const { error } = await CLOUD.sb.from("customer_portals").upsert({
    token: j.portal.token,
    company_id: CLOUD.company,
    job_id: j.id,
    code: j.portal.code,
    data: portalSnapshot(j),
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}
const portalPublishQuiet = (j) => {
  if (j.portal?.token && isOwnerCloud())
    portalPublish(j).catch(() =>
      toast(
        "Saved here, but the customer page didn't update. It will try again on your next change.",
      ),
    );
};

async function portalUpload(j, blob, name) {
  if (!isOwnerCloud()) throw new Error("Sign in first");
  portalEnsure(j);
  const ext =
    (
      String(name).match(/\.([a-z0-9]{1,8})$/i)?.[1] ||
      (blob.type.split("/")[1] || "bin").split(";")[0]
    )
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "bin";
  const path = `${CLOUD.company}/${j.portal.token}/${uid()}.${ext}`;
  const { error } = await CLOUD.sb.storage
    .from(PORTAL_BUCKET)
    .upload(path, blob, {
      contentType: blob.type || "application/octet-stream",
      upsert: false,
    });
  if (error) throw error;
  return path;
}
function portalRemoveFiles(paths) {
  paths = paths.filter(Boolean);
  if (paths.length && isOwnerCloud())
    CLOUD.sb.storage
      .from(PORTAL_BUCKET)
      .remove(paths)
      .catch(() => {});
}
const portalItemPaths = (it) =>
  [
    ...(it.files || []).map((f) => f.path),
    it.voice?.path,
    ...(it.options || []).flatMap((o) => [o.img, ...(o.files || []).map((f) => f.path)]),
  ].filter(Boolean);

/* ----- the add / edit form ----- */
function portalForm(j, it, kind) {
  const isNew = !it,
    cloud = isOwnerCloud();
  it = it || {
    kind,
    title: "",
    date: "",
    desc: "",
    price: "",
    files: [],
    voice: null,
    options:
      kind === "pick"
        ? [
            { id: uid(), label: "", price: "", img: "" },
            { id: uid(), label: "", price: "", img: "" },
          ]
        : [],
  };
  // Work on copies so Cancel leaves the item untouched. New uploads wait in `pending` until Save.
  const st = {
    kind: it.kind,
    files: [...(it.files || [])],
    voice: it.voice,
    options: (it.options || []).map((o) => ({ ...o })),
    pending: new Map(),
    rec: null,
  };
  if (!st.options.length)
    st.options = [
      { id: uid(), label: "", price: "", img: "" },
      { id: uid(), label: "", price: "", img: "" },
    ];
  const isPick = () => st.kind === "pick";
  const urlOf = (ref) =>
    st.pending.get(ref)?.url || (ref ? portalFileUrl(ref) : "");
  const optFiles = (o) =>
    (o.files || [])
      .map((x, i) => `<span class="portal-chip">${/^image\//.test(x.type) ? `<img src="${esc(urlOf(x.path))}" alt="">` : ""}<span>${esc(x.name)}</span><button type="button" data-opt-file-del="${i}" aria-label="Remove ${esc(x.name)}">×</button></span>`)
      .join("");
  const optRow = (o) => `<div class="portal-opt" data-opt="${o.id}">
      <label class="portal-opt-img" title="Add a photo of this option">${o.img ? `<img src="${esc(urlOf(o.img))}" alt="">` : "<span>+ Photo</span>"}<input type="file" accept="image/*" data-opt-img hidden${cloud ? "" : " disabled"}></label>
      <div class="grow"><input data-opt-label value="${esc(o.label)}" placeholder="e.g. Matte white subway tile" maxlength="200" aria-label="Option name">
        <input data-opt-price inputmode="decimal" value="${o.price === "" || o.price == null ? "" : esc(o.price)}" placeholder="Price (optional)" aria-label="Option price">
        <div class="portal-opt-files">${optFiles(o)}<label class="btn sm" style="flex-direction:row;color:var(--ink)">+ More photos or files<input type="file" multiple accept="image/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.txt" data-opt-file hidden${cloud ? "" : " disabled"}></label></div></div>
      <button type="button" class="btn sm ghost" data-opt-del aria-label="Remove option">×</button></div>`;
  const fileRow = (f, i) =>
    `<li><div class="grow"><b>${esc(f.name)}</b><small>${esc((f.type || "").split("/")[0] === "image" ? "Photo" : "File")}${f.size ? " · " + Math.max(1, Math.round(f.size / 1024)) + " KB" : ""}</small></div><button type="button" class="btn sm ghost" data-file-del="${i}" aria-label="Remove ${esc(f.name)}">×</button></li>`;
  const voiceBox = () =>
    st.voice
      ? `<div class="portal-voice"><audio controls preload="none" src="${esc(urlOf(st.voice.path))}"></audio><button type="button" class="btn sm ghost" data-voice-del>Remove</button></div>`
      : st.rec
        ? '<div class="portal-voice"><span class="portal-rec-dot" aria-hidden="true"></span><span class="grow" id="rec-time">Recording 0:00</span><button type="button" class="btn sm primary" data-voice-stop>Stop</button></div>'
        : `<button type="button" class="btn sm" data-voice-rec${cloud ? "" : " disabled"}>Record a voice memo</button>`;

  openForm({
    title: isNew
      ? kind === "pick"
        ? "New customer pick"
        : "New milestone"
      : "Edit " + (it.kind === "pick" ? "customer pick" : "milestone"),
    submit: isNew ? "Add" : "Save",
    body: `<div class="fields">
      ${field("Type", `<select name="kind">${opt("pick", "Customer pick (they choose)", st.kind)}${opt("milestone", "Milestone (you do)", st.kind)}</select>`, "full")}
      ${field("Title", inp("title", it.title, "text", 'required maxlength="120" placeholder="e.g. Pick the shower tile"'), "full")}
      ${field(`<span id="portal-date-label">${isPick() ? "Decide by" : "Date"}</span>`, inp("date", it.date, "date"))}
      ${field("Price (optional)", moneyInp("price", it.price))}
      ${field("Description", `<textarea name="desc" rows="3" maxlength="3000" placeholder="What they need to know">${esc(it.desc || "")}</textarea>`, "full")}
      </div>
      <div id="portal-opts-wrap"${isPick() ? "" : " hidden"}><div class="split"><b>Options</b><button type="button" class="btn sm" data-opt-add>+ Add option</button></div>
        <p class="note" style="margin:4px 0 8px">The customer taps one. Leave these blank to let them type their answer instead.</p><div id="portal-opts">${st.options.map(optRow).join("")}</div>
        <label class="check" style="margin-top:8px"><input type="checkbox" name="locked"${it.locked ? " checked" : ""}> Lock the choice (customer can't change it anymore)</label></div>
      <div><div class="split"><b>Photos &amp; files</b><label class="btn sm" style="flex-direction:row;color:var(--ink)">+ Add<input type="file" multiple accept="image/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.txt" data-file-add hidden${cloud ? "" : " disabled"}></label></div>
        <ul class="list" id="portal-files">${st.files.map(fileRow).join("")}</ul></div>
      <div><b>Voice memo</b><div id="portal-voice" style="margin-top:6px">${voiceBox()}</div></div>
      <label class="check" id="portal-done-wrap"${isPick() ? " hidden" : ""}><input type="checkbox" name="done"${it.done ? " checked" : ""}> Done</label>
      ${
        !isNew && it.pick
          ? `<div class="insight good"><b>Picked</b><span>${esc(portalPickLabel(it.pick))}${it.pick.label && it.pick.note ? ' · "' + esc(it.pick.note) + '"' : ""}${it.pick.name ? " · by " + esc(it.pick.name) : ""} · ${fmtDate(ds(new Date(it.pick.at)))}</span></div>
        <button type="button" class="btn sm ghost" data-pick-clear style="align-self:flex-start">Clear their pick so they can choose again</button>`
          : ""
      }
      ${cloud ? "" : '<div class="insight"><b>Sign in</b><span>Create a free account (Settings) to add photos, files and voice memos and to send this page to your customer.</span></div>'}`,
    onOpen: (f) => {
      const refreshVoice = () => {
        $("#portal-voice", f).innerHTML = voiceBox();
      };
      f.elements.kind.addEventListener("change", () => {
        st.kind = f.elements.kind.value;
        $("#portal-opts-wrap", f).hidden = !isPick();
        $("#portal-date-label", f).textContent = isPick()
          ? "Decide by"
          : "Date";
        $("#portal-done-wrap", f).hidden = isPick();
      });
      const readOpts = () =>
        $$(".portal-opt", f).forEach((row) => {
          const o = st.options.find((x) => x.id === row.dataset.opt);
          if (o) {
            o.label = $("[data-opt-label]", row).value;
            o.price = $("[data-opt-price]", row).value;
          }
        });
      f.addEventListener("click", async (e) => {
        const t = e.target.closest("button");
        if (!t) return;
        if (t.matches("[data-opt-add]")) {
          readOpts();
          const o = { id: uid(), label: "", price: "", img: "" };
          st.options.push(o);
          $("#portal-opts", f).insertAdjacentHTML("beforeend", optRow(o));
          $(`[data-opt="${o.id}"] [data-opt-label]`, f).focus();
        } else if (t.matches("[data-opt-file-del]")) {
          const row = t.closest(".portal-opt"),
            o = st.options.find((x) => x.id === row.dataset.opt);
          o.files.splice(+t.dataset.optFileDel, 1);
          $(".portal-opt-files", row).querySelectorAll(".portal-chip").forEach((c) => c.remove());
          $(".portal-opt-files", row).insertAdjacentHTML("afterbegin", optFiles(o));
        } else if (t.matches("[data-opt-del]")) {
          const row = t.closest(".portal-opt");
          st.options = st.options.filter((o) => o.id !== row.dataset.opt);
          row.remove();
        } else if (t.matches("[data-file-del]")) {
          st.files.splice(+t.dataset.fileDel, 1);
          $("#portal-files", f).innerHTML = st.files.map(fileRow).join("");
        } else if (t.matches("[data-voice-del]")) {
          st.voice = null;
          refreshVoice();
        } else if (t.matches("[data-voice-rec]")) {
          try {
            st.rec = await portalRecord((sec) => {
              const el = $("#rec-time", f);
              if (el)
                el.textContent = `Recording ${Math.floor(sec / 60)}:${pad(sec % 60)}`;
            });
            refreshVoice();
          } catch (err) {
            toast(err.message || "Could not use the microphone");
          }
        } else if (t.matches("[data-voice-stop]")) {
          const r = st.rec;
          st.rec = null;
          const { blob, sec } = await r.stop();
          if (blob.size) {
            const ref = "new:" + uid();
            st.pending.set(ref, {
              blob,
              name:
                "voice-memo." + (blob.type.includes("mp4") ? "m4a" : "webm"),
              url: URL.createObjectURL(blob),
            });
            st.voice = { path: ref, type: blob.type, sec };
          }
          refreshVoice();
        } else if (t.matches("[data-pick-clear]")) {
          if (!armTwoStep(t, "Tap again to clear it")) return;
          await portalClearPick(j, it);
          t.previousElementSibling?.remove();
          t.remove();
          toast("Cleared. They can pick again.");
        }
      });
      f.addEventListener("change", async (e) => {
        const t = e.target;
        if (t.matches("[data-file-add]")) {
          for (const file of t.files) {
            const blob = file.type.startsWith("image/")
              ? await downscale(file, 2000)
              : file;
            const ref = "new:" + uid();
            st.pending.set(ref, { blob, name: file.name, url: "" });
            st.files.push({
              path: ref,
              name: file.name,
              type: blob.type || file.type,
              size: blob.size,
            });
          }
          t.value = "";
          $("#portal-files", f).innerHTML = st.files.map(fileRow).join("");
        } else if (t.matches("[data-opt-file]") && t.files.length) {
          const row = t.closest(".portal-opt"),
            o = st.options.find((x) => x.id === row.dataset.opt);
          o.files = o.files || [];
          for (const file of t.files) {
            const isImg = file.type.startsWith("image/"),
              blob = isImg ? await downscale(file, 2000) : file,
              ref = "new:" + uid();
            st.pending.set(ref, { blob, name: file.name, url: isImg ? URL.createObjectURL(blob) : "" });
            o.files.push({ path: ref, name: file.name, type: blob.type || file.type });
          }
          t.value = "";
          $(".portal-opt-files", row).querySelectorAll(".portal-chip").forEach((c) => c.remove());
          $(".portal-opt-files", row).insertAdjacentHTML("afterbegin", optFiles(o));
        } else if (t.matches("[data-opt-img]") && t.files[0]) {
          const row = t.closest(".portal-opt"),
            o = st.options.find((x) => x.id === row.dataset.opt),
            blob = await downscale(t.files[0], 1400);
          const ref = "new:" + uid();
          st.pending.set(ref, {
            blob,
            name: t.files[0].name,
            url: URL.createObjectURL(blob),
          });
          o.img = ref;
          $(".portal-opt-img", row).firstElementChild.outerHTML =
            `<img src="${esc(urlOf(ref))}" alt="">`;
        }
      });
      f.closest("dialog")?.addEventListener(
        "close",
        () => {
          st.rec?.cancel();
          st.pending.forEach((p) => p.url && URL.revokeObjectURL(p.url));
        },
        { once: true },
      );
      f._readOpts = readOpts;
    },
    onDelete: isNew
      ? null
      : () => {
          j.portal.items = j.portal.items.filter((x) => x.id !== it.id);
          portalRemoveFiles(portalItemPaths(it));
          if (it.pick) portalClearPick(j, it);
          save();
          portalPublishQuiet(j);
          toast("Removed from the customer page");
        },
    deleteLabel: "Remove",
    onSubmit: async (fd, f) => {
      if (st.rec) {
        toast("Stop the recording first");
        return false;
      }
      f._readOpts();
      const title = String(fd.get("title")).trim();
      if (!title) {
        toast("Give it a title");
        return false;
      }
      const options = isPick()
        ? st.options
            .filter((o) => o.label.trim() || o.img || (o.files || []).length)
            .map((o) => Object.assign(o, { label: o.label.trim() || "Option" }))
        : [];
      // Upload anything new, then swap the temporary references for real storage paths.
      if (st.pending.size) {
        toast("Uploading…");
        try {
          for (const [ref, p] of st.pending) {
            const used =
              st.files.some((x) => x.path === ref) ||
              st.voice?.path === ref ||
              options.some((o) => o.img === ref || (o.files || []).some((x) => x.path === ref));
            if (!used) continue;
            const path = await portalUpload(j, p.blob, p.name);
            st.files.forEach((x) => {
              if (x.path === ref) x.path = path;
            });
            if (st.voice?.path === ref) st.voice.path = path;
            options.forEach((o) => {
              if (o.img === ref) o.img = path;
              (o.files || []).forEach((x) => {
                if (x.path === ref) x.path = path;
              });
            });
          }
        } catch (err) {
          toast("Upload failed: " + errMsg(err));
          return false;
        }
      }
      const before = new Set(portalItemPaths(it));
      Object.assign(it, {
        kind: st.kind,
        title,
        date: fd.get("date") || "",
        desc: String(fd.get("desc") || "").trim(),
        price: String(fd.get("price") || "").trim(),
        files: st.files,
        voice: st.voice,
        options,
        done: st.kind === "milestone" ? !!fd.get("done") : false,
        locked: st.kind === "pick" ? !!fd.get("locked") : false,
      });
      if (st.kind === "milestone" && it.pick) await portalClearPick(j, it);
      const after = new Set(portalItemPaths(it));
      portalRemoveFiles([...before].filter((p) => !after.has(p)));
      if (isNew) {
        it.id = uid();
        it.createdAt = isoNow();
        portalEnsure(j).items.push(it);
      }
      save();
      portalPublishQuiet(j);
      toast(isNew ? "Added to the customer page" : "Saved");
    },
  });
}

// Voice memo through the microphone. Safari records audio/mp4; Chrome records audio/webm.
async function portalRecord(onTick) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
    throw new Error("Voice memos aren't supported on this device");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    throw new Error("Allow microphone access to record a voice memo");
  }
  const type =
    ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) =>
      MediaRecorder.isTypeSupported?.(t),
    ) || "";
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined),
    chunks = [],
    t0 = Date.now();
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const tick = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    onTick(s);
    if (s >= 300 && rec.state === "recording") rec.stop();
  }, 500);
  const done = new Promise((res) => {
    rec.onstop = () => {
      clearInterval(tick);
      stream.getTracks().forEach((t) => t.stop());
      res({
        blob: new Blob(chunks, { type: rec.mimeType || type || "audio/mp4" }),
        sec: Math.round((Date.now() - t0) / 1000),
      });
    };
  });
  rec.start(1000);
  return {
    stop: () => {
      if (rec.state === "recording") rec.stop();
      return done;
    },
    cancel: () => {
      if (rec.state === "recording") rec.stop();
    },
  };
}

async function portalClearPick(j, it) {
  delete it.pick;
  save();
  if (isOwnerCloud() && j.portal?.token)
    await CLOUD.sb
      .from("portal_choices")
      .delete()
      .eq("token", j.portal.token)
      .eq("item_id", it.id)
      .then(
        () => {},
        () => {},
      );
}

/* ----- sending the link ----- */
async function portalSend(j) {
  const box = $("#portal-send-box");
  if (!isOwnerCloud()) {
    box.innerHTML =
      '<div class="insight" style="margin-top:10px"><b>Sign in</b><span>Create a free account (Settings) to send your customer a link to this page.</span></div>';
    return;
  }
  box.innerHTML = '<p class="note">Making the link…</p>';
  try {
    await portalPublish(j);
    save();
  } catch (e) {
    box.innerHTML = `<p class="note neg">Couldn't make the link: ${esc(errMsg(e))}</p>`;
    return;
  }
  portalShowInvite(box, j);
}
const portalCodeShow = (code) => code.slice(0, 4) + "-" + code.slice(4);
function portalShowInvite(box, j) {
  const c = j.customerId ? cust(j.customerId) : null,
    phone = c?.phone || j.phone,
    email = c?.email || "";
  const first = (c?.name || j.client || "").split(" ")[0],
    co = S.profile?.company || "",
    url = portalUrl(j),
    code = portalCodeShow(j.portal.code);
  const waiting = (j.portal.items || []).filter((i) => i.kind === "pick" && !i.pick).length;
  const msg = `Hi${first ? " " + first : ""}, here's the page for your ${j.name || "project"}${co ? " with " + co : ""}. It has the schedule${waiting ? ` and ${waiting} choice${waiting > 1 ? "s" : ""} we need from you` : ""}: ${url}\n\nUsing the Blue Board app? Tap "I'm a customer" and enter code ${code}.`;
  const sms = smsLink(phone, msg),
    mail = email
      ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent((j.name || "Your project") + (co ? " · " + co : ""))}&body=${encodeURIComponent(msg)}`
      : "";
  box.innerHTML = `<div class="portal-code" style="margin-top:10px"><span>Customer code</span><b>${esc(code)}</b><small>They open the link, or type this code in the Blue Board app.</small></div>
    <div class="btns" style="margin-top:8px">${sms ? `<a class="btn sm primary" href="${esc(sms)}">Text ${esc(first || "customer")}</a>` : ""}${mail ? `<a class="btn sm${sms ? "" : " primary"}" href="${esc(mail)}">Email</a>` : ""}<button type="button" class="btn sm" data-portal-copy>Copy message</button></div>
    ${!sms && !mail ? '<p class="note" style="margin-top:6px">Add their phone or email to the customer to text or email it from here.</p>' : ""}
    <p class="note" style="margin-top:6px;word-break:break-all">${esc(url)}</p>`;
  $("[data-portal-copy]", box).onclick = async () => {
    try {
      await navigator.clipboard.writeText(msg);
      toast("Copied. Paste it in a text or email.");
    } catch (err) {
      toast("Could not copy");
    }
  };
}

/* ----- inviting a customer: new or existing customer, new or existing job, in one form ----- */
function portalInviteForm(pre = {}) {
  if (!isOwnerCloud()) {
    openForm({ title: "Invite a customer", closeLabel: "Close", body: '<div class="insight"><b>Sign in</b><span>Create a free account (Settings) to invite customers. They get their own page with the schedule and the choices they need to make.</span></div>' });
    return;
  }
  const custs = [...S.customers].sort((a, b) => a.name.localeCompare(b.name));
  const jobsFor = (cid) => S.jobs.filter((j) => j.customerId === cid && j.status !== "done");
  const jobOpts = (cid) => `${jobsFor(cid).map((j) => opt(j.id, j.name, pre.jobId)).join("")}${opt("new", "+ New job", jobsFor(cid).length ? "" : "new")}`;
  let made = null;
  openForm({
    title: "Invite a customer",
    submit: "Create invite",
    body: `<p class="note" id="inv-intro">They get a page with the schedule and the choices they need to make. No account needed.</p>
      <div class="fields" id="inv-fields">
      ${field("Customer", `<select name="cid">${opt("new", "+ New customer", pre.customerId ? "" : "new")}${custs.map((c) => opt(c.id, c.name, pre.customerId)).join("")}</select>`, "full")}
      <div class="fields full" id="inv-new-cust">
        ${field("Name", inp("name", "", "text", 'autocomplete="off" placeholder="e.g. Luis Garcia"'), "full")}
        ${field("Phone", inp("phone", "", "tel"))}${field("Email", inp("email", "", "email"))}</div>
      ${field("Job", `<select name="jid">${jobOpts(pre.customerId || "")}</select>`, "full")}
      <div class="fields full" id="inv-new-job">
        ${field("Job name", inp("jobName", "", "text", 'placeholder="e.g. Backyard patio and sprinklers"'), "full")}
        ${field("Address", inp("address", ""), "full")}</div>
      </div><div id="inv-result"></div>`,
    onOpen: (f) => {
      const upd = () => {
        const cid = f.elements.cid.value;
        $("#inv-new-cust", f).hidden = cid !== "new";
        if (f.dataset.cid !== cid) {
          f.dataset.cid = cid;
          f.elements.jid.innerHTML = jobOpts(cid === "new" ? "" : cid);
        }
        $("#inv-new-job", f).hidden = f.elements.jid.value !== "new";
      };
      f.elements.cid.addEventListener("change", upd);
      f.elements.jid.addEventListener("change", upd);
      upd();
    },
    onSubmit: async (fd, f) => {
      // Second press, after the invite is made: go to the job to add dates and picks.
      if (made) { location.hash = "#/job/" + made.id; return true; }
      let c = fd.get("cid") === "new" ? null : cust(fd.get("cid"));
      if (!c) {
        const name = String(fd.get("name") || "").trim();
        if (!name) { toast("Enter the customer's name"); return false; }
        c = { id: uid(), name, phone: String(fd.get("phone") || "").trim(), email: String(fd.get("email") || "").trim(), address: String(fd.get("address") || "").trim(), notes: "" };
        S.customers.push(c);
      }
      let j = fd.get("jid") === "new" ? null : job(fd.get("jid"));
      if (!j) {
        const name = String(fd.get("jobName") || "").trim() || c.name.split(" ").slice(-1)[0] + " project";
        j = { id: uid(), createdAt: Date.now(), changeOrders: [], name, client: c.name, customerId: c.id, phone: c.phone || "", address: String(fd.get("address") || "").trim() || c.address || "", status: "active", price: 0, start: today(), end: "", notes: "", est: {} };
        S.jobs.push(j);
      }
      portalEnsure(j);
      save();
      const box = $("#inv-result", f);
      box.innerHTML = '<p class="note">Making the invite…</p>';
      try { await portalPublish(j); } catch (e) { box.innerHTML = `<p class="note neg">Couldn't make the invite: ${esc(errMsg(e))}</p>`; return false; }
      made = j;
      $("#inv-fields", f).hidden = true;
      $("#inv-intro", f).innerHTML = `<b>${esc(c.name)}</b> is invited to <b>${esc(j.name)}</b>. Send them the invite, then add dates and picks on the job.`;
      portalShowInvite(box, j);
      $("[type=submit]", f).textContent = "Open the job";
      $$("[data-close].btn", f).forEach((x) => (x.textContent = "Close"));
      return false;
    },
  });
}

/* ----- picking up the customer's picks ----- */
async function portalsPull() {
  if (!isOwnerCloud()) return false;
  const jobs = S.jobs.filter((j) => j.portal?.token);
  if (!jobs.length) return false;
  const [{ data, error }, views] = await Promise.all([
    CLOUD.sb
      .from("portal_choices")
      .select("token,item_id,option_id,label,note,name,decided_at")
      .eq("company_id", CLOUD.company),
    CLOUD.sb
      .from("customer_portals")
      .select("token,viewed_at")
      .eq("company_id", CLOUD.company),
  ]);
  if (error || !data) return false;
  let ch = false;
  for (const r of data) {
    const j = jobs.find((x) => x.portal.token === r.token),
      it = j?.portal.items.find((x) => x.id === r.item_id);
    if (!it || it.pick?.at === r.decided_at) continue;
    it.pick = {
      optionId: r.option_id || "",
      label: r.label,
      note: r.note,
      name: r.name,
      at: r.decided_at,
    };
    ch = true;
    toast(
      `${r.name || j.client || "Your customer"} picked ${portalPickLabel(it.pick)} for ${it.title}`,
    );
  }
  for (const v of views.data || []) {
    const j = jobs.find((x) => x.portal.token === v.token);
    if (j && v.viewed_at && j.portal.viewedAt !== v.viewed_at) {
      j.portal.viewedAt = v.viewed_at;
      ch = true;
    }
  }
  if (ch) save();
  portalsRefresh();
  return ch;
}

/* ----- wiring into the app ----- */
Object.assign(ACT, {
  "cust-invite": (a) => portalInviteForm({ customerId: a.dataset.id || "", jobId: curJob()?.id || "" }),
  "portal-new": (a) => {
    const j = curJob();
    if (j) portalForm(j, null, a.dataset.kind);
  },
  "portal-edit": (a) => {
    const j = curJob(),
      it = j?.portal?.items.find((x) => x.id === a.dataset.id);
    if (it) portalForm(j, it);
  },
  "portal-send": () => {
    const j = curJob();
    if (j) portalSend(j);
  },
  "portal-preview": () => {
    const j = curJob();
    if (j?.portal?.token) window.open(portalUrl(j), "_blank", "noopener");
  },
});
document.head.insertAdjacentHTML(
  "beforeend",
  `<style>
.portal-opt{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--line);border-radius:var(--r-sm);margin-bottom:8px;background:var(--surface)}
.portal-opt .grow{display:flex;flex-direction:column;gap:6px;min-width:0}
.portal-opt-img{width:64px;height:64px;flex:none;border-radius:12px;background:var(--surface2);border:1px dashed var(--line2);display:grid;place-items:center;overflow:hidden;cursor:pointer;font-size:12px;color:var(--muted)}
.portal-opt-img img{width:100%;height:100%;object-fit:cover}
.portal-code{display:flex;flex-direction:column;gap:2px;padding:14px 16px;border-radius:var(--r-sm);background:var(--hi-soft)}
.portal-code span{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.portal-code b{font:800 26px/1.2 Manrope,sans-serif;letter-spacing:.08em;color:var(--ink)}
.portal-code small{color:var(--muted);font-size:12.5px}
.portal-opt-files{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.portal-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 4px 3px 4px;border-radius:999px;background:var(--surface2);font-size:12.5px;font-weight:600;color:var(--ink)}
.portal-chip img{width:22px;height:22px;border-radius:50%;object-fit:cover}
.portal-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;padding-left:4px}
.portal-chip button{appearance:none;border:0;background:none;font:inherit;color:var(--muted);cursor:pointer;padding:0 6px;font-size:15px}
.portal-voice{display:flex;gap:10px;align-items:center}.portal-voice audio{flex:1;min-width:0;height:40px}
.portal-rec-dot{width:10px;height:10px;border-radius:50%;background:var(--bad);animation:portal-pulse 1s ease-in-out infinite}
@keyframes portal-pulse{50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.portal-rec-dot{animation:none}}
.badge.bad{background:var(--bad-bg);color:var(--bad)}
</style>`,
);

// Account deletion: remove every customer page file. The table rows go with the company
// (on delete cascade), but storage files don't, and this bucket is public.
async function portalWipe() {
  if (!isOwnerCloud() || !CLOUD.company) return;
  const bucket = CLOUD.sb.storage.from(PORTAL_BUCKET);
  try {
    const { data: folders } = await bucket.list(CLOUD.company, { limit: 1000 });
    const tokens = new Set([...(folders || []).filter((o) => !o.id).map((o) => o.name), ...S.jobs.map((j) => j.portal?.token).filter(Boolean)]);
    for (const t of tokens) {
      const pre = `${CLOUD.company}/${t}`;
      for (let n = 0; n < 50; n++) {
        const { data } = await bucket.list(pre, { limit: 100 });
        const files = (data || []).filter((o) => o.id);
        if (!files.length) break;
        const { error } = await bucket.remove(files.map((o) => `${pre}/${o.name}`));
        if (error) break;
      }
    }
  } catch (e) {
    console.error('Customer page files were not all removed', e);
  }
}

// Job deleted: take its customer page down and delete its files.
function portalUnpublish(j) {
  if (!j.portal?.token || !isOwnerCloud()) return;
  portalRemoveFiles((j.portal.items || []).flatMap(portalItemPaths));
  CLOUD.sb.from('customer_portals').delete().eq('token', j.portal.token).then(() => {}, () => {});
}

// Keep each customer page current when the job or company details change (name, address,
// phone, logo). Runs with the regular sync; only writes when the page content actually changed.
const portalLastPublished = new Map();
async function portalsRefresh() {
  if (!isOwnerCloud()) return;
  for (const j of S.jobs) {
    if (!j.portal?.token) continue;
    const snap = JSON.stringify(portalSnapshot(j));
    if (!portalLastPublished.has(j.portal.token)) { portalLastPublished.set(j.portal.token, snap); continue; }
    if (portalLastPublished.get(j.portal.token) === snap) continue;
    try { await portalPublish(j); portalLastPublished.set(j.portal.token, snap); } catch (e) { console.error('Customer page refresh failed', e); }
  }
}

/* ----- customers opening their page with a code ----- */
// A customer who entered a code only ever sees their own page: on this device the app opens
// straight to it. "Use a different code" on that page clears this and comes back to sign-in.
const PORTAL_CUSTOMER_KEY = "bb.customer";
const portalCustomerGet = () => { try { return localStorage.getItem(PORTAL_CUSTOMER_KEY) || ""; } catch (e) { return ""; } };
const portalOpenAsCustomer = (token) => location.replace("portal.html?app=1#" + token);
(() => {
  const t = portalCustomerGet();
  if (/^[0-9a-f]{32,}$/.test(t) && !/^#\/(signin|reset|newpw|join)/.test(location.hash)) portalOpenAsCustomer(t);
})();
async function portalLookupCode(code) {
  const sb = sbClient();
  if (!sb) throw new Error("Can't reach Blue Board. Check your connection.");
  const { data, error } = await sb.rpc("portal_token_for_code", { p_code: code });
  if (error) throw new Error("That didn't go through. Check your connection and try again.");
  return data || "";
}
const portalAuthBase = pageAuth;
pageAuth = function () {
  const html = portalAuthBase();
  if (LS.get("invite")) return html; // crew invite in progress: keep that screen focused
  const box = `<div class="card auth-card stack auth-cust"><div><h2>I'm a customer</h2><p class="note">Enter the code your contractor sent you to see your project.</p></div>
    <form id="cust-code-form" class="stack" novalidate>
      ${field("Customer code", inp("code", "", "text", 'placeholder="ABCD-EFGH" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" inputmode="text"'))}
      <p class="note neg" id="cust-code-err" hidden></p>
      <button class="btn primary big" type="submit">Open my project</button></form></div>`;
  return html.replace(/<\/div>\s*$/, box + "</div>");
};
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "cust-code-form") return;
  e.preventDefault();
  const f = e.target, err = $("#cust-code-err", f), btn = $("[type=submit]", f);
  const code = f.code.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const fail = (m) => { err.hidden = false; err.textContent = m; btn.disabled = false; btn.textContent = "Open my project"; };
  if (code.length !== 8) return fail("Customer codes are 8 letters and numbers, like ABCD-EFGH.");
  btn.disabled = true; btn.textContent = "Opening…";
  try {
    const token = await portalLookupCode(code);
    if (!token) return fail("That code wasn't found. Check it against the text from your contractor.");
    try { localStorage.setItem(PORTAL_CUSTOMER_KEY, token); } catch (x) {}
    portalOpenAsCustomer(token);
  } catch (x) { fail(x.message); }
});
document.addEventListener("input", (e) => {
  if (e.target.form?.id !== "cust-code-form" || e.target.name !== "code") return;
  const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  e.target.value = raw.length > 4 ? raw.slice(0, 4) + "-" + raw.slice(4) : raw;
});
document.head.insertAdjacentHTML("beforeend", "<style>.auth{gap:16px;align-content:center}.auth-cust{padding:22px 26px}.auth-cust h2{font-size:18px;margin:0 0 2px}.auth-cust input[name=code]{font:800 20px Manrope,sans-serif;letter-spacing:.12em;text-transform:uppercase}</style>");
