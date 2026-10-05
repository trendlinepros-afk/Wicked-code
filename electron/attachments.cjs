// Reads files dropped/attached into a chat: extracts text from documents (Word, PDF, Excel,
// PowerPoint, text/code) and loads images for vision models.
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_TEXT_CHARS = 120_000 // per file (~30K tokens); longer documents are truncated

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }
const UNSUPPORTED = {
  '.doc': 'Old Word format (.doc) — save it as .docx and drop it again.',
  '.xls': 'Old Excel format (.xls) — save it as .xlsx and drop it again.',
  '.ppt': 'Old PowerPoint format (.ppt) — save it as .pptx and drop it again.',
  '.zip': 'Zip archives aren’t supported — unzip and drop the files inside.',
  '.exe': 'Programs can’t be attached.',
}

const clip = (text) =>
  text.length > MAX_TEXT_CHARS
    ? { text: text.slice(0, MAX_TEXT_CHARS) + `\n\n… [truncated: showing the first ${MAX_TEXT_CHARS.toLocaleString()} of ${text.length.toLocaleString()} characters]`, truncated: true }
    : { text, truncated: false }

async function docxToText(file) {
  const mammoth = require('mammoth')
  // Markdown keeps headings, lists and tables readable for the model.
  const fn = mammoth.convertToMarkdown || mammoth.extractRawText
  const { value } = await fn({ path: file })
  // mammoth escapes Markdown punctuation ("help\\."); unescape it so the model sees clean text.
  return value.replace(/\\([\\`*_{}\[\]()#+\-.!>|])/g, '$1').replace(/\n{3,}/g, '\n\n').trim()
}

async function pdfToText(file) {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(await fsp.readFile(file)))
  const { totalPages, text } = await extractText(pdf, { mergePages: false })
  const pages = Array.isArray(text) ? text : [text]
  const body = pages.map((t, i) => `--- Page ${i + 1} ---\n${String(t).trim()}`).join('\n\n')
  if (!body.replace(/--- Page \d+ ---/g, '').trim()) throw new Error('This PDF has no selectable text (it may be scanned images).')
  return { text: body, pages: totalPages }
}

async function xlsxToText(file) {
  const ExcelJS = require('exceljs')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const out = []
  wb.eachSheet((sheet) => {
    out.push(`## Sheet: ${sheet.name}`)
    let rows = 0
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rows++ >= 5000) return
      const cells = (row.values || []).slice(1).map((v) => {
        if (v == null) return ''
        if (typeof v === 'object') return v.result ?? v.text ?? (v.richText ? v.richText.map((r) => r.text).join('') : v instanceof Date ? v.toISOString().slice(0, 10) : JSON.stringify(v))
        return String(v)
      })
      out.push(cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
    })
    if (rows > 5000) out.push(`… [${rows - 5000} more rows not shown]`)
    out.push('')
  })
  return out.join('\n').trim()
}

async function pptxToText(file) {
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(await fsp.readFile(file))
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/g).pop()) - Number(b.match(/\d+/g).pop()))
  const out = []
  for (const [i, name] of slides.entries()) {
    const xml = await zip.file(name).async('string')
    const paras = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')).filter(Boolean)
    out.push(`--- Slide ${i + 1} ---\n${paras.map(decodeXml).join('\n')}`)
  }
  return out.join('\n\n')
}

const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** Heuristic: is this a text file? (no NUL bytes in the first 8 KB) */
async function looksLikeText(file) {
  const fd = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(8192)
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0)
    return !buf.subarray(0, bytesRead).includes(0)
  } finally {
    await fd.close()
  }
}

/**
 * Extract one file. Returns an attachment record:
 * { name, path, ext, size, kind: 'document'|'text'|'image', mime?, text?, truncated?, pages?, chars?, error? }
 */
async function extractFile(file) {
  const name = path.basename(file)
  const ext = path.extname(file).toLowerCase()
  const base = { name, path: file, ext }
  try {
    const st = await fsp.stat(file)
    if (st.isDirectory()) return { ...base, size: 0, kind: 'text', error: 'Folders can’t be attached here — use “Add folder” instead.' }
    base.size = st.size
    if (UNSUPPORTED[ext]) return { ...base, kind: 'document', error: UNSUPPORTED[ext] }
    if (IMAGE_TYPES[ext]) {
      if (st.size > MAX_IMAGE_BYTES) return { ...base, kind: 'image', error: 'Image is larger than 20 MB.' }
      return { ...base, kind: 'image', mime: IMAGE_TYPES[ext] }
    }
    if (st.size > MAX_FILE_BYTES) return { ...base, kind: 'document', error: 'File is larger than 50 MB.' }
    let text
    let pages
    let kind = 'document'
    if (ext === '.docx') text = await docxToText(file)
    else if (ext === '.pdf') ({ text, pages } = await pdfToText(file))
    else if (ext === '.xlsx' || ext === '.xlsm') text = await xlsxToText(file)
    else if (ext === '.pptx') text = await pptxToText(file)
    else if (await looksLikeText(file)) {
      text = await fsp.readFile(file, 'utf8')
      kind = 'text'
    } else return { ...base, kind: 'document', error: 'Unsupported file type (not text, an image, or a Word/PDF/Excel/PowerPoint file).' }
    const c = clip(text)
    return { ...base, kind, text: c.text, truncated: c.truncated, chars: text.length, pages }
  } catch (e) {
    return { ...base, size: base.size ?? 0, kind: 'document', error: String(e.message || e) }
  }
}

async function extractFiles(paths) {
  return Promise.all(paths.map(extractFile))
}

/** Load an image attachment for a vision model: { mime, data (base64) } or null if it's gone. */
function loadImage(att) {
  try {
    if (!att?.path || !IMAGE_TYPES[path.extname(att.path).toLowerCase()]) return null
    const data = fs.readFileSync(att.path).toString('base64')
    return { mime: IMAGE_TYPES[path.extname(att.path).toLowerCase()], data }
  } catch {
    return null
  }
}

/**
 * Turn user messages with attachments into model-ready messages: document text is placed before the
 * user's words; images (only the most recent few, to bound memory) go in `images`.
 */
function expandAttachments(messages, { maxImages = 4 } = {}) {
  let imagesLeft = maxImages
  const out = messages.map((m) => ({ ...m }))
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (m.role !== 'user' || !m.attachments?.length) continue
    const docs = m.attachments.filter((a) => a.kind !== 'image' && a.text && !a.error)
    const imgs = m.attachments.filter((a) => a.kind === 'image' && !a.error)
    if (docs.length) {
      const blocks = docs.map(
        (a) => `<attached_file name="${a.name}" path="${a.path}"${a.pages ? ` pages="${a.pages}"` : ''}>\n${a.text}\n</attached_file>`,
      )
      m.content = `${blocks.join('\n\n')}\n\n${m.content}`
    }
    if (imgs.length) {
      const loaded = []
      for (const a of imgs) {
        if (imagesLeft <= 0) break
        const img = loadImage(a)
        if (img) {
          loaded.push(img)
          imagesLeft--
        }
      }
      if (loaded.length) m.images = loaded
      const names = imgs.map((a) => a.name).join(', ')
      m.content = `[Attached image${imgs.length > 1 ? 's' : ''}: ${names}]\n\n${m.content}`
    }
    delete m.attachments
  }
  return out
}

module.exports = { extractFiles, extractFile, expandAttachments, loadImage, IMAGE_TYPES, MAX_TEXT_CHARS }
