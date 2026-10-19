// ?font=<id> on any page (local only): swap the site's font for one of the candidates in /_fonts/fonts.js
(() => {
  const id = new URLSearchParams(location.search).get("font");
  if (!id) return;
  const s = document.createElement("script");
  s.src = "/_fonts/fonts.js";
  s.onload = () => {
    const f = (window.HUB_FONTS || []).find((x) => x.id === id);
    if (!f) return;
    const fam = window.hubFontFace(f);
    const st = document.createElement("style");
    st.textContent = `body, .logo, button, input, textarea, .headline, h1, h2, h3 { font-family: ${fam} !important; }`;
    document.head.append(st);
    const tag = document.createElement("div");
    tag.textContent = `Font preview: ${f.letter} · ${f.name}`;
    tag.style.cssText = "position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:999;background:#0c0d12;color:#fff;font:500 12px/1 ui-monospace,monospace;padding:9px 14px;border-radius:999px";
    document.body.append(tag);
  };
  document.head.append(s);
})();
