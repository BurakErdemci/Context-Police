const VERDICT_LABELS = {
  gecerli: "geçerli",
  curuk: "çürük",
  "dogustan-yanlis": "doğuştan yanlış",
  olculemez: "ölçülemez",
  tarihsel: "tarihsel",
};

function verdictLabel(v) {
  return VERDICT_LABELS[v] ?? v;
}

function shortSha(sha) {
  if (typeof sha !== "string" || sha === "") return "—";
  return sha.slice(0, 7);
}

function localDate(iso) {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function mount(root, ctx, findingId) {
  root.textContent = "";
  const wrap = document.createElement("div");
  wrap.className = "detail";
  root.appendChild(wrap);

  function renderMessage(text, showQueueLink) {
    wrap.textContent = "";
    const msg = document.createElement("div");
    msg.className = "screen-message";
    msg.textContent = text;
    wrap.appendChild(msg);
    if (showQueueLink === true) {
      const link = document.createElement("a");
      link.href = "#/";
      link.textContent = "Kuyruğa dön";
      link.className = "queue-link";
      wrap.appendChild(link);
    }
  }

  function renderHeader(d) {
    const header = document.createElement("div");
    header.className = "panel detail-header";

    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = `not #${d.id}`;
    header.appendChild(eyebrow);

    const content = document.createElement("pre");
    content.className = "detail-content";
    content.textContent = d.content;
    header.appendChild(content);

    const meta = document.createElement("dl");
    meta.className = "detail-meta";
    const addMeta = (term, value) => {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.dataset.mono = "";
      dd.textContent = value;
      meta.append(dt, dd);
    };
    addMeta("kaynak", d.sourceRef ?? "—");
    addMeta("durum", d.status);
    addMeta("şüphe skoru", Number(d.suspicion).toFixed(2));
    addMeta("oluşturulma", localDate(d.createdAt));
    if (d.supersededBy !== null && d.supersededBy !== undefined) {
      addMeta("değiştirildi", `#${d.supersededBy}`);
    }
    header.appendChild(meta);

    return header;
  }

  function renderAnchors(anchors) {
    const section = document.createElement("div");
    section.className = "panel";

    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "çapalar";
    section.appendChild(eyebrow);

    if (anchors.length === 0) {
      const p = document.createElement("p");
      p.className = "empty-note";
      p.textContent = "Çapa yok — bu not sürüklenme sinyali üretemez.";
      section.appendChild(p);
      return section;
    }

    const table = document.createElement("table");
    table.className = "queue-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const h of ["tür", "değer", "alındığı commit"]) {
      const th = document.createElement("th");
      th.textContent = h;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const a of anchors) {
      const tr = document.createElement("tr");
      const kind = document.createElement("td");
      kind.dataset.mono = "";
      kind.textContent = a.kind;
      const value = document.createElement("td");
      value.dataset.mono = "";
      value.textContent = a.value;
      const commit = document.createElement("td");
      commit.dataset.mono = "";
      commit.textContent = shortSha(a.takenAtCommit);
      tr.append(kind, value, commit);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  // key/value ledger line; prose=true sets the value in the editorial serif.
  function ledgerField(key, value, prose) {
    const p = document.createElement("p");
    p.className = "ledger-field";
    const k = document.createElement("span");
    k.className = "ledger-field__k";
    k.textContent = key;
    const v = document.createElement("span");
    v.className = prose === true ? "ledger-field__v ledger-field__v--prose" : "ledger-field__v";
    v.textContent = value;
    p.append(k, v);
    return p;
  }

  function renderVerdictBody(record) {
    const body = document.createElement("div");
    body.className = "ledger-body";

    if (record.subReason !== null && record.subReason !== "") {
      body.appendChild(ledgerField("alt sebep", record.subReason, false));
    }
    if (record.decayType !== null && record.decayType !== "") {
      body.appendChild(ledgerField("çürüme türü", record.decayType, false));
    }
    if (record.evidence !== null && record.evidence !== "") {
      body.appendChild(ledgerField("kanıt", record.evidence, true));
    }
    if (record.method !== null && record.method !== "") {
      body.appendChild(ledgerField("yöntem", record.method, false));
    }
    return body;
  }

  function renderLiveRecord(record) {
    const live = document.createElement("div");
    live.className = "ledger-live";

    const head = document.createElement("div");
    head.className = "ledger-live-head";
    const badge = document.createElement("span");
    badge.className = `badge badge--${record.verdict}`;
    badge.textContent = verdictLabel(record.verdict);
    head.appendChild(badge);
    if (record.repeatCount > 1) {
      const repeat = document.createElement("span");
      repeat.className = "ledger-repeat";
      repeat.dataset.mono = "";
      repeat.textContent = `×${record.repeatCount} koşum aynı sonucu ölçtü`;
      head.appendChild(repeat);
    }
    live.appendChild(head);
    live.appendChild(renderVerdictBody(record));

    if (record.correction !== null && record.correction !== "") {
      const corr = document.createElement("div");
      corr.className = "correction";
      const label = document.createElement("p");
      label.className = "eyebrow";
      label.textContent = "önerilen düzeltme";
      const text = document.createElement("p");
      text.textContent = record.correction;
      corr.append(label, text);
      live.appendChild(corr);
    }

    return live;
  }

  function renderHistoryRecord(record) {
    const item = document.createElement("div");
    item.className = "ledger-old";

    const head = document.createElement("div");
    head.className = "ledger-old-head";
    const label = document.createElement("span");
    label.className = `badge badge--${record.verdict} ledger-old-label`;
    label.textContent = verdictLabel(record.verdict);
    head.appendChild(label);

    const supersededNote = document.createElement("span");
    supersededNote.className = "ledger-old-note";
    supersededNote.dataset.mono = "";
    const supersededBy = record.supersededBy !== null ? `#${record.supersededBy}` : "bilinmiyor";
    supersededNote.textContent = `#${record.id} — ${supersededBy} ile değiştirildi — ${localDate(record.createdAt)}`;
    head.appendChild(supersededNote);
    item.appendChild(head);
    item.appendChild(renderVerdictBody(record));

    return item;
  }

  function renderClaim(claim) {
    const card = document.createElement("div");
    card.className = "panel ledger";

    const title = document.createElement("p");
    title.className = "eyebrow";
    title.textContent = claim.claimRef === "" ? "iddia: not geneli" : `iddia: ${claim.claimRef}`;
    card.appendChild(title);

    if (claim.live !== null) {
      card.appendChild(renderLiveRecord(claim.live));
    } else {
      const none = document.createElement("p");
      none.className = "empty-note";
      none.textContent = "Bu iddia için canlı hüküm yok.";
      card.appendChild(none);
    }

    const historical = claim.history.filter((v) => claim.live === null || v.id !== claim.live.id);
    if (historical.length > 0) {
      const histTitle = document.createElement("p");
      histTitle.className = "eyebrow ledger-hist-title";
      histTitle.textContent = "tarihsel kayıtlar";
      card.appendChild(histTitle);
      for (const record of historical) {
        card.appendChild(renderHistoryRecord(record));
      }
    }

    return card;
  }

  async function load() {
    try {
      const d = await ctx.apiGet(`/api/findings/${findingId}`);
      if (d.storeMissing === true) {
        renderMessage(
          `Depo bulunamadı: ${d.path} — \`context-police audit\` bir koşum sonra burayı doldurur.`,
          true,
        );
        return;
      }
      if (d.schemaOutdated === true) {
        renderMessage("Depo bu gezginden eski — `context-police audit` bir kez koşunca güncellenir.", true);
        return;
      }
      wrap.textContent = "";
      // Two-column ledger: note + anchors on the left, verdict claims on the right.
      const noteCol = document.createElement("div");
      noteCol.className = "detail-col detail-col--note";
      const claimsCol = document.createElement("div");
      claimsCol.className = "detail-col detail-col--claims";

      noteCol.appendChild(renderHeader(d));
      noteCol.appendChild(renderAnchors(d.anchors));
      if (d.claims.length === 0) {
        const none = document.createElement("p");
        none.className = "empty-note";
        none.textContent = "Bu not için hüküm kaydı yok.";
        claimsCol.appendChild(none);
      } else {
        for (const claim of d.claims) {
          claimsCol.appendChild(renderClaim(claim));
        }
      }
      // entrance stagger indices, left column first then claims
      let seq = 0;
      for (const col of [noteCol, claimsCol]) {
        for (const panel of col.children) {
          panel.style.setProperty("--i", String(seq));
          seq += 1;
        }
      }
      wrap.append(noteCol, claimsCol);
    } catch (err) {
      if (err instanceof Error && /HTTP 404/.test(err.message)) {
        renderMessage("Bulgu bulunamadı.", true);
        return;
      }
      renderMessage(`Yükleme hatası: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  load();
  return { refresh: load };
}
