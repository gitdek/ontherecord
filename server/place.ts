// Puts new files beside one the scan saw, in the meetings folder. It is the only writing the server does
// there, and it only ever adds: every name has to be free, and a file that turned up meanwhile is left as it is.
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { NOFOLLOW, stillScanned, type FileEntry } from './library.ts'
import { missing, syncFolder } from './persistence.ts'

export type NewFile = { name: string; text: string }

const usable = (name: string) => name.length > 0 && !name.startsWith('.') && !/[/\\\0]/.test(name) && Buffer.byteLength(name) <= 240

// How a disk that can't hard-link (exFAT, FAT, some network shares) answers a link.
const NO_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'EMLINK', 'ENOSYS'])

// Created only where nothing stands yet, and never through a symlink.
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW

const free = (path: string) =>
  lstat(path).then(
    () => false,
    (err) => {
      if (missing(err)) return true
      throw err
    },
  )

// A file written whole under a name nothing has yet: its inode, or undefined when the name turned out to be taken.
async function create(path: string, text: string): Promise<number | undefined> {
  const fh = await open(path, CREATE, 0o644).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw err
  })
  if (!fh) return
  try {
    await fh.writeFile(text)
    await fh.sync()
    return (await fh.stat()).ino
  } finally {
    await fh.close()
  }
}

// Names this call placed are taken back only while they still lead to what it wrote.
async function takeBack(placed: { path: string; ino: number }[]) {
  for (const p of placed) {
    const s = await lstat(p.path).catch(() => undefined)
    if (s?.isFile() && s.ino === p.ino) await unlink(p.path).catch(() => {})
  }
}

// Each file is written whole under a hidden name, which the scan skips, and then given its real name with a hard
// link. A link fails where a rename would replace, so nothing already there is ever written over, and the folder
// never shows half a file. A disk without hard links gets each file created straight under its real name, again
// only where that name is free. The files go in together or not at all: when a name is taken before or while they
// go in, the ones placed so far are taken back, so a transcript someone drops in by hand is never paired with half
// of this one. Returns the names placed, in the order given: all of them, or none.
export async function placeBeside(beside: FileEntry, files: NewFile[]): Promise<string[]> {
  for (const f of files) if (!usable(f.name)) throw new Error(`${JSON.stringify(f.name)} is not a name a file can be placed under`)
  if (new Set(files.map((f) => f.name)).size !== files.length) throw new Error('two of the files have the same name')
  if (!files.length) return []
  await stillScanned(beside)
  const dir = dirname(beside.path)
  for (const f of files) if (!(await free(join(dir, f.name)))) return []
  const hidden: { path: string; ino: number }[] = []
  const placed: { path: string; ino: number }[] = []
  let links = true
  try {
    for (const f of files) {
      const path = join(dir, `.${randomUUID()}.writing`)
      const ino = await create(path, f.text)
      if (ino === undefined) throw new Error(`a hidden file to write ${f.name} under was already there`)
      hidden.push({ path, ino })
    }
    for (const [i, f] of files.entries()) {
      const to = join(dir, f.name)
      let ino: number | undefined
      if (links) {
        try {
          await link(hidden[i].path, to)
          ino = hidden[i].ino
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? ''
          if (code !== 'EEXIST' && !NO_LINKS.has(code)) throw err
          links = code === 'EEXIST'
        }
      }
      if (!links) ino = await create(to, f.text)
      if (ino === undefined) {
        await takeBack(placed)
        return []
      }
      placed.push({ path: to, ino })
    }
  } catch (err) {
    await takeBack(placed)
    throw err
  } finally {
    for (const h of hidden) await rm(h.path, { force: true }).catch(() => {})
  }
  await syncFolder(placed[0].path)
  return files.map((f) => f.name)
}
