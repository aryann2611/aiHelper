// Small Markdown renderer for AI replies, shared by the app and the overlay: headings, bullets, bold,
// inline code and fenced code blocks with light syntax colouring. Escapes everything first.
(function (root) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const KEYWORDS = 'abstract|async|await|boolean|break|case|catch|char|class|const|continue|def|default|do|double|elif|else|enum|export|extends|false|final|finally|float|for|from|func|function|if|implements|import|in|int|interface|let|long|new|None|null|package|private|protected|public|return|self|static|String|struct|super|switch|this|throw|throws|True|False|true|try|var|void|while|with|yield';
  // comments | strings | numbers | keywords — matched left to right, so a "#" or "//" inside a string stays a string
  const TOKENS = new RegExp(`(\\/\\/[^\\n]*|(?<![\\w"'#])#(?!include)[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(\\b\\d+(?:\\.\\d+)?\\b)|(\\b(?:${KEYWORDS})\\b)`, 'g');

  function highlight(code) {
    let out = '', last = 0;
    for (const m of code.matchAll(TOKENS)) {
      out += esc(code.slice(last, m.index));
      out += `<span class="tk-${m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : 'k'}">${esc(m[0])}</span>`;
      last = m.index + m[0].length;
    }
    return out + esc(code.slice(last));
  }
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  function md(text) {
    let html = '', list = false, code = null, lang = '';
    const closeList = () => { if (list) { html += '</ul>'; list = false; } };
    const closeCode = () => { html += `<pre class="code">${lang ? `<span class="lang">${esc(lang)}</span>` : ''}<code>${highlight(code.join('\n'))}</code></pre>`; code = null; };
    for (const raw of String(text ?? '').split('\n')) {
      const fence = raw.match(/^\s*```\s*([\w+#.-]*)/);
      if (fence) { if (code) closeCode(); else { closeList(); code = []; lang = fence[1]; } continue; }
      if (code) { code.push(raw); continue; }
      const line = raw.trimEnd().replace(/^\s*> ?/, ''), b = line.match(/^\s*[-*•] (.*)/), h = line.match(/^#{1,4} (.*)/);
      if (!b) closeList();
      if (b) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(b[1])}</li>`; }
      else if (h) html += `<h3>${inline(h[1])}</h3>`;
      else if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
    if (code) closeCode(); // still streaming: show the code written so far
    closeList();
    return html;
  }

  if (typeof module === 'object' && module.exports) module.exports = { md, highlight };
  else root.md = md;
})(globalThis);
