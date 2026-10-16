#!/usr/bin/env node
// Rebuilds src/data/sources.json from the Matomo "searchengine-and-social-list" (CC0 1.0):
//   https://github.com/matomo-org/searchengine-and-social-list
// Development tool only, it is not part of the Docker image and snar never fetches anything at runtime.
//
//   node scripts/update-sources.js              download the current lists from GitHub
//   node scripts/update-sources.js --from DIR   read Socials.yml, SearchEngines.yml, AIAssistants.yml and LICENSE from DIR
//
// Look at the diff of src/data/sources.json before committing it. The lists are plain YAML of a very small shape (a name,
// then a list of host names); the reader below accepts exactly that and stops on anything else instead of guessing.

const fs = require('node:fs');
const path = require('node:path');

const REPO = 'matomo-org/searchengine-and-social-list';
const RAW = `https://raw.githubusercontent.com/${REPO}/master/`;
const FILES = { social: 'Socials.yml', search: 'SearchEngines.yml', ai: 'AIAssistants.yml' };
const OUT = path.join(__dirname, '..', 'src', 'data', 'sources.json');

const unquote = (s) => {
  const m = /^(['"])(.*)\1$/.exec(s);
  return m ? m[2] : s;
};

// kind 'simple' (Socials, AIAssistants): "Name:" followed by "  - host" lines.
// kind 'search' (SearchEngines): "Name:", then configurations ("  -" with indented keys), only the urls lists are used.
function parseList(text, kind, label) {
  const out = new Map(); // name -> [entries]
  let current = null;
  let inUrls = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    const where = `${label}:${i + 1}`;
    if (line === '' || line.startsWith('#')) return;
    if (!/^\s/.test(line)) { // top level: a name
      const m = /^(.+):$/.exec(line);
      if (!m || line.startsWith('-')) throw new Error(`${where}: unexpected top-level line: ${line}`);
      current = decodeURIComponent(unquote(m[1]));
      if (!out.has(current)) out.set(current, []);
      inUrls = false;
      return;
    }
    if (current === null) throw new Error(`${where}: indented line before the first name`);
    if (kind === 'simple') {
      const m = /^ {2}- (.+)$/.exec(line);
      if (!m) throw new Error(`${where}: unexpected line: ${line}`);
      out.get(current).push(unquote(m[1].trim()));
      return;
    }
    if (/^ {2}-$/.test(line)) { inUrls = false; return; } // a new configuration
    // "  - urls:" is a new configuration whose first key sits on the dash line; "    urls:" a key inside one
    const key = /^(?: {2}- | {4})([a-z]+):\s*(.*)$/.exec(line);
    if (key) {
      if (!['urls', 'params', 'backlink', 'charsets', 'hiddenkeyword'].includes(key[1])) throw new Error(`${where}: unknown key ${key[1]}`);
      inUrls = key[1] === 'urls';
      return;
    }
    const item = /^ {6}- (.+)$/.exec(line);
    if (!item) throw new Error(`${where}: unexpected line: ${line}`);
    if (inUrls) out.get(current).push(unquote(item[1].trim()));
  });
  return out;
}

// Keeps host names and "{}" patterns (the lists' placeholder for a country code); drops everything with a path or
// anything else, because snar stores only the host name of a referrer. Returns { groups, skipped }.
function toGroup(map) {
  const groups = {};
  let skipped = 0;
  for (const [name, entries] of map) {
    const keep = [];
    for (const e of entries) {
      const host = e.toLowerCase();
      if (!/^[a-z0-9{}.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.')) { skipped++; continue; }
      if (!keep.includes(host)) keep.push(host);
    }
    if (keep.length) groups[name] = keep;
  }
  return { groups, skipped };
}

async function load(dir, file) {
  if (dir) return fs.readFileSync(path.join(dir, file), 'utf8');
  const res = await fetch(RAW + file);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const args = process.argv.slice(2);
  const from = args[0] === '--from' ? args[1] : null;
  if (args.length && !from) throw new Error('usage: update-sources.js [--from DIR]');

  const license = await load(from, 'LICENSE');
  if (!/^\s*CC0 1\.0 Universal/.test(license)) throw new Error('LICENSE is not CC0 1.0 Universal any more: stop and read the new terms first.');

  const meta = { source: `https://github.com/${REPO}`, license: 'CC0-1.0', fetched: new Date().toISOString().slice(0, 10) };
  if (!from) {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/commits/master`, { headers: { accept: 'application/vnd.github+json' } });
      if (res.ok) meta.commit = (await res.json()).sha;
    } catch { /* the commit id is only a note */ }
  }

  const result = { _meta: meta };
  const minimum = { social: 50, search: 150, ai: 8 }; // a download that came back (almost) empty must not overwrite good data
  let skippedTotal = 0;
  for (const [group, file] of Object.entries(FILES)) {
    const { groups, skipped } = toGroup(parseList(await load(from, file), group === 'search' ? 'search' : 'simple', file));
    if (Object.keys(groups).length < minimum[group]) throw new Error(`${file}: only ${Object.keys(groups).length} entries, expected at least ${minimum[group]}`);
    result[group] = groups;
    skippedTotal += skipped;
    console.log(`${file}: ${Object.keys(groups).length} names, ${Object.values(groups).reduce((a, h) => a + h.length, 0)} hosts, ${skipped} entries with a path or odd characters skipped`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // One line per name keeps the diff of an update readable.
  const block = (obj) => '{\n' + Object.entries(obj).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n') + '\n }';
  fs.writeFileSync(OUT, '{\n' + Object.entries(result).map(([k, v]) => ` ${JSON.stringify(k)}: ${k === '_meta' ? JSON.stringify(v) : block(v)}`).join(',\n') + '\n}\n');
  console.log(`written ${path.relative(process.cwd(), OUT)} (${skippedTotal} skipped in total)`);
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });
module.exports = { parseList, toGroup };
