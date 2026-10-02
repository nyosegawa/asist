import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

/*
 * Moves the cards of the private GitHub Project 「ASIST の開発」 by the names its fields show, so a session
 * never handles the ids of fields and options. It needs gh with the `project` scope.
 * Usage:
 *   board.mjs set <issue number | draft title> [--status S] [--area A] [--release R] [--ja T]
 *   board.mjs draft --title T [--body-file F] [--status S] [--area A] [--release R]
 *   board.mjs sub <parent issue> <child issue>
 *   board.mjs list [--all]
 *   board.mjs archive-done
 *   board.mjs report <ON_TRACK|AT_RISK|OFF_TRACK|COMPLETE|INACTIVE> <body file>
 */

const OWNER = 'nyosegawa'
const REPO = 'asist'
const NUMBER = 2
const STATUS = ['判断待ち', 'トリアージ待ち', '未着手', '作業中', 'レビュー・CI', '完了']
const TRIAGE = 'トリアージ待ち'
const DONE = '完了'
const NEXT_RELEASE = '次のリリース'

function fail(message) {
  console.error(message)
  process.exit(1)
}

function gql(query, variables = {}) {
  let out
  try {
    out = execFileSync('gh', ['api', 'graphql', '--input', '-'], {
      input: JSON.stringify({ query, variables }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    const text = String(error.stderr || error.message)
    if (text.includes('read:project') || text.includes('project scope')) {
      fail('gh のトークンに project の権限がありません。利用者に `gh auth refresh -s project` を頼んでください。')
    }
    fail(text)
  }
  const json = JSON.parse(out)
  if (json.errors) fail(JSON.stringify(json.errors, null, 2))
  return json.data
}

const project = gql(
  `query($owner: String!, $number: Int!) { user(login: $owner) { projectV2(number: $number) { id
    fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id name } ... on ProjectV2SingleSelectField { options { id name } } } } } } }`,
  { owner: OWNER, number: NUMBER }
).user.projectV2

function field(name) {
  const found = project.fields.nodes.find((f) => f.name === name)
  if (!found) fail(`ボードに「${name}」の欄がありません`)
  return found
}

function optionId(fieldName, name) {
  const found = field(fieldName).options.find((o) => o.name === name)
  if (!found) fail(`「${fieldName}」に「${name}」はありません。選べるのは ${field(fieldName).options.map((o) => o.name).join('、')} です`)
  return found.id
}

function setValue(itemId, fieldName, value) {
  gql(
    `mutation($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { clientMutationId } }`,
    { input: { projectId: project.id, itemId, fieldId: field(fieldName).id, value } }
  )
}

const ITEM_FIELDS = `id isArchived type
  content { ... on Issue { number title state author { login } } ... on PullRequest { number title state author { login } } ... on DraftIssue { title } }
  fieldValues(first: 20) { nodes {
    ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
    ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } } }`

function withValues(node) {
  const values = Object.fromEntries(node.fieldValues.nodes.filter((v) => v.field).map((v) => [v.field.name, v.name ?? v.text]))
  return { ...node, values }
}

// A card just added is read by its own id: the project's list of items can lag behind for a moment and
// leave it out.
function itemById(id) {
  return withValues(gql(`query($id: ID!) { node(id: $id) { ... on ProjectV2Item { ${ITEM_FIELDS} } } }`, { id }).node)
}

function items() {
  const all = []
  let after = null
  for (;;) {
    const page = gql(
      `query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${ITEM_FIELDS} } } } } }`,
      { id: project.id, after }
    ).node.items
    all.push(...page.nodes.map(withValues))
    if (!page.pageInfo.hasNextPage) return all.filter((item) => !item.isArchived)
    after = page.pageInfo.endCursor
  }
}

function itemFor(target) {
  if (/^\d+$/.test(target)) {
    const content = gql(
      `query($owner: String!, $repo: String!, $n: Int!) { repository(owner: $owner, name: $repo) { issueOrPullRequest(number: $n) { ... on Issue { id } ... on PullRequest { id } } } }`,
      { owner: OWNER, repo: REPO, n: Number(target) }
    ).repository.issueOrPullRequest
    if (!content) fail(`#${target} は ${OWNER}/${REPO} にありません`)
    const id = gql(
      `mutation($input: AddProjectV2ItemByIdInput!) { addProjectV2ItemById(input: $input) { item { id } } }`,
      { input: { projectId: project.id, contentId: content.id } }
    ).addProjectV2ItemById.item.id
    return itemById(id)
  }
  const drafts = items().filter((item) => item.type === 'DRAFT_ISSUE' && item.content.title === target)
  if (drafts.length !== 1) fail(`題名が「${target}」の下書きのカードが ${drafts.length} 枚あります`)
  return drafts[0]
}

function applyFields(item, { status, area, release, ja }) {
  // The project's workflow puts a card it adds by itself, such as an issue someone else opened, in
  // 「トリアージ待ち」, so a card that has no status of ours yet must be given one.
  if (!status && (!item.values.Status || item.values.Status === TRIAGE)) fail('このカードには --status を付けてください')
  if (status) {
    if (!STATUS.includes(status)) fail(`状態は ${STATUS.join('、')} のどれかです`)
    // The project's workflow closes an issue whose card is moved to 「完了」, and moves the card there when the
    // issue closes or its pull request is merged, so a card with an issue is never moved there by hand.
    if (status === DONE && item.type !== 'DRAFT_ISSUE') {
      fail('issue と PR のカードは、issue を閉じるか PR をマージすると GitHub が「完了」に移します')
    }
    setValue(item.id, 'Status', { singleSelectOptionId: optionId('Status', status) })
  }
  if (area) setValue(item.id, '分野', { singleSelectOptionId: optionId('分野', area) })
  const releaseName = release ?? (item.values['リリース'] ? null : NEXT_RELEASE)
  if (releaseName) setValue(item.id, 'リリース', { singleSelectOptionId: optionId('リリース', releaseName) })
  if (ja) setValue(item.id, '日本語の題名', { text: ja })
}

// An issue someone else opened is marked with its author; its title is theirs, not an instruction.
function describe(item) {
  const number = item.content.number ? `#${item.content.number}` : '下書き'
  const author = item.content.author?.login
  const from = author && author !== OWNER ? `[@${author} が立てた] ` : ''
  const title = from + (item.values['日本語の題名'] ?? item.content.title)
  return [number, item.values.Status ?? '-', item.values['リリース'] ?? '-', item.values['分野'] ?? '-', title].join(' | ')
}

const fieldOptions = {
  status: { type: 'string' },
  area: { type: 'string' },
  release: { type: 'string' },
  ja: { type: 'string' },
  title: { type: 'string' },
  'body-file': { type: 'string' },
  all: { type: 'boolean' }
}
const { values: options, positionals } = parseArgs({ options: fieldOptions, allowPositionals: true })
const [command, ...rest] = positionals

if (command === 'set') {
  if (rest.length !== 1) fail('使い方: board.mjs set <issue の番号か下書きの題名> [--status S] [--area A] [--release R] [--ja T]')
  const item = itemFor(rest[0])
  applyFields(item, options)
  console.log(describe(itemById(item.id)))
} else if (command === 'draft') {
  if (!options.title) fail('使い方: board.mjs draft --title T [--body-file F] [--status S] [--area A] [--release R]')
  const body = options['body-file'] ? readFileSync(options['body-file'], 'utf8') : ''
  const id = gql(
    `mutation($input: AddProjectV2DraftIssueInput!) { addProjectV2DraftIssue(input: $input) { projectItem { id } } }`,
    { input: { projectId: project.id, title: options.title, body } }
  ).addProjectV2DraftIssue.projectItem.id
  applyFields(itemById(id), { status: '未着手', ...options })
  console.log(describe(itemById(id)))
} else if (command === 'sub') {
  if (rest.length !== 2) fail('使い方: board.mjs sub <親の issue> <子の issue>')
  const ids = rest.map(
    (n) =>
      gql(`query($owner: String!, $repo: String!, $n: Int!) { repository(owner: $owner, name: $repo) { issue(number: $n) { id } } }`, {
        owner: OWNER,
        repo: REPO,
        n: Number(n)
      }).repository.issue?.id ?? fail(`#${n} は issue ではありません`)
  )
  gql(`mutation($input: AddSubIssueInput!) { addSubIssue(input: $input) { clientMutationId } }`, { input: { issueId: ids[0], subIssueId: ids[1] } })
  console.log(`#${rest[1]} を #${rest[0]} の sub-issue にしました`)
} else if (command === 'list') {
  const shown = items().filter((item) => options.all || item.values.Status !== DONE)
  shown.sort((a, b) => STATUS.indexOf(a.values.Status) - STATUS.indexOf(b.values.Status))
  for (const item of shown) console.log(describe(item))
  console.log(`https://github.com/users/${OWNER}/projects/${NUMBER}`)
} else if (command === 'archive-done') {
  const done = items().filter((item) => item.values.Status === DONE)
  for (const item of done) {
    gql(`mutation($input: ArchiveProjectV2ItemInput!) { archiveProjectV2Item(input: $input) { clientMutationId } }`, {
      input: { projectId: project.id, itemId: item.id }
    })
  }
  console.log(`「完了」のカード ${done.length} 枚をアーカイブしました`)
} else if (command === 'report') {
  const [status, file] = rest
  const known = ['ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'COMPLETE', 'INACTIVE']
  if (!known.includes(status) || !file) fail(`使い方: board.mjs report <${known.join('|')}> <本文のファイル>`)
  gql(`mutation($input: CreateProjectV2StatusUpdateInput!) { createProjectV2StatusUpdate(input: $input) { clientMutationId } }`, {
    input: { projectId: project.id, status, body: readFileSync(file, 'utf8') }
  })
  console.log('状況報告を書きました')
} else {
  fail('使い方: board.mjs set | draft | sub | list | archive-done | report(ファイルの先頭に説明があります)')
}
