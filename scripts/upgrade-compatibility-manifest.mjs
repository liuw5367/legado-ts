#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

const path = new URL('../fixtures/compatibility/method-manifest.json', import.meta.url)
const manifest = JSON.parse(await readFile(path, 'utf8'))

const slug = (value) => value
  .toLowerCase()
  .replace(/[^a-z0-9]+/gu, '-')
  .replace(/^-+|-+$/gu, '')
  .slice(0, 48) || 'member'

const members = []
for (const entry of manifest.entries) {
  const previousMembers = Array.isArray(entry.members) ? entry.members : []
  entry.members = entry.androidMethods.map((name, index) => {
    const previous = previousMembers.find((member) => member?.name === name) ?? previousMembers[index]
    const member = {
      id: previous?.id ?? `${entry.id}::${String(index + 1).padStart(3, '0')}-${slug(name)}`,
      owner: previous?.owner ?? entry.androidOwner,
      name,
      signature: previous?.signature ?? name,
      parameters: previous?.parameters ?? [],
      returnType: previous?.returnType ?? 'unknown',
      implementation: previous?.implementation ?? entry.implementation,
      verification: previous?.verification ?? entry.verification,
      feasibility: previous?.feasibility ?? entry.feasibility,
      decision: previous?.decision ?? entry.decision,
      fixtures: previous?.fixtures ?? entry.fixtures ?? [],
      errorCodes: previous?.errorCodes ?? entry.errorCodes ?? [],
    }
    members.push(member)
    return member
  })
}
manifest.version = 2
manifest.memberCount = members.length
await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify({ version: manifest.version, entries: manifest.entries.length, members: members.length }))
