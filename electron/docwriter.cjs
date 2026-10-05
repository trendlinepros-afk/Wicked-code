// Writes documents the model produces in chat: Markdown → .docx (headings, lists, bold/italic,
// code, tables), or plain text for other extensions. Never overwrites an existing file.
const fsp = require('fs/promises')
const fs = require('fs')
const path = require('path')

/** Split inline Markdown (**bold**, *italic*, `code`) into docx TextRuns. */
function inlineRuns(docx, text) {
  const runs = []
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`)/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) runs.push(new docx.TextRun(text.slice(last, m.index)))
    const t = m[0]
    if (t.startsWith('**') || t.startsWith('__')) runs.push(new docx.TextRun({ text: t.slice(2, -2), bold: true }))
    else if (t.startsWith('`')) runs.push(new docx.TextRun({ text: t.slice(1, -1), font: 'Consolas' }))
    else runs.push(new docx.TextRun({ text: t.slice(1, -1), italics: true }))
    last = m.index + t.length
  }
  if (last < text.length) runs.push(new docx.TextRun(text.slice(last)))
  return runs.length ? runs : [new docx.TextRun('')]
}

function markdownToDocxChildren(docx, md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n')
  const children = []
  const HEADINGS = [docx.HeadingLevel.HEADING_1, docx.HeadingLevel.HEADING_2, docx.HeadingLevel.HEADING_3, docx.HeadingLevel.HEADING_4, docx.HeadingLevel.HEADING_5, docx.HeadingLevel.HEADING_6]
  let para = []
  const flush = () => {
    if (para.length) children.push(new docx.Paragraph({ children: inlineRuns(docx, para.join(' ')) }))
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (/^```/.test(trimmed)) {
      flush()
      const code = []
      while (++i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i])
      for (const c of code) children.push(new docx.Paragraph({ children: [new docx.TextRun({ text: c || ' ', font: 'Consolas', size: 20 })] }))
      continue
    }
    // Pipe table: header row, separator row, body rows.
    if (/^\|.*\|$/.test(trimmed) && /^\|?\s*:?-{2,}/.test((lines[i + 1] || '').trim())) {
      flush()
      const rows = [trimmed]
      i++
      while (i + 1 < lines.length && /^\|.*\|$/.test(lines[i + 1].trim())) rows.push(lines[++i].trim())
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      children.push(
        new docx.Table({
          width: { size: 100, type: docx.WidthType.PERCENTAGE },
          rows: rows.map(
            (r, ri) =>
              new docx.TableRow({
                tableHeader: ri === 0,
                children: cells(r).map(
                  (c) => new docx.TableCell({ children: [new docx.Paragraph({ children: ri === 0 ? [new docx.TextRun({ text: c, bold: true })] : inlineRuns(docx, c) })] }),
                ),
              }),
          ),
        }),
      )
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (h) {
      flush()
      children.push(new docx.Paragraph({ heading: HEADINGS[h[1].length - 1], children: inlineRuns(docx, h[2]) }))
      continue
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      flush()
      children.push(new docx.Paragraph({ bullet: { level: Math.min(Math.floor(bullet[1].length / 2), 8) }, children: inlineRuns(docx, bullet[2]) }))
      continue
    }
    const num = /^(\s*)\d+[.)]\s+(.*)$/.exec(line)
    if (num) {
      flush()
      children.push(new docx.Paragraph({ numbering: { reference: 'numbers', level: Math.min(Math.floor(num[1].length / 2), 8) }, children: inlineRuns(docx, num[2]) }))
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush()
      children.push(new docx.Paragraph({ thematicBreak: true, children: [] }))
      continue
    }
    if (!trimmed) {
      flush()
      continue
    }
    para.push(trimmed.replace(/^>\s?/, ''))
  }
  flush()
  return children
}

async function markdownToDocx(md) {
  const docx = require('docx')
  const doc = new docx.Document({
    numbering: {
      config: [
        {
          reference: 'numbers',
          levels: Array.from({ length: 9 }, (_, level) => ({ level, format: docx.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: docx.AlignmentType.START })),
        },
      ],
    },
    sections: [{ children: markdownToDocxChildren(docx, md) }],
  })
  return docx.Packer.toBuffer(doc)
}

/** Pick a filename that doesn't exist yet: "report (edited).docx", "report (edited 2).docx", … */
function freePath(target) {
  if (!fs.existsSync(target)) return target
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const base = path.basename(target, ext)
  for (let n = 2; n < 1000; n++) {
    const p = path.join(dir, `${base} (${n})${ext}`)
    if (!fs.existsSync(p)) return p
  }
  throw new Error('Could not find a free file name.')
}

/**
 * Save a document next to the user's attached files.
 * @param {string[]} allowedDirs  folders of the attached files
 */
async function saveDocument(allowedDirs, { filename, content }) {
  if (!allowedDirs.length) throw new Error('No attached files — there is no folder to save into.')
  const name = path.basename(String(filename || '').trim())
  if (!name || name.startsWith('.')) throw new Error('Give the file a name, e.g. "Report (edited).docx".')
  const target = freePath(path.join(allowedDirs[0], name))
  const ext = path.extname(target).toLowerCase()
  const data = ext === '.docx' ? await markdownToDocx(content) : String(content ?? '')
  await fsp.writeFile(target, data)
  return `Saved ${target}${path.basename(target) !== name ? ` (a file named ${name} already existed, so it was not overwritten)` : ''}.`
}

module.exports = { saveDocument, markdownToDocx, freePath }
