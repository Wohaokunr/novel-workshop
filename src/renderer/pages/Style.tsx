import { useEffect, useMemo, useState } from 'react';
import { BookMarked, Check, FlaskConical, Pin, PinOff, Plus, RefreshCw, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import type { OperationBatch, Workspace } from '../../shared/types';
import { originNames, personNames, scaleNames, STYLE_LIMITS, STYLE_SCALES, styleProfile, type StyleLearningStatus, type StylePerson, type StyleProfile, type StyleScale, type StyleSuggestion } from '../../shared/style-types';
import { AI_CLICHES, styleBaseline, styleFingerprint, styleLint, type StyleFingerprint } from '../../shared/style-metrics';
import { authoredPassages } from '../../shared/style-provenance';
import { passageLabel } from '../../shared/structure';
import { Dialog, Field, characters, fire, orderedPassages, uid, type Commit } from '../ui';
import { useCompanion } from '../Companion';

/** Fingerprints over the last part of a long book stay cheap and still describe the current voice. */
const SAMPLE_TAIL = 60_000;
const count = (text: string) => text.replace(/\s/g, '').length;

type Patch = (style: StyleProfile) => Partial<StyleProfile>;

export function Style({ workspace: w, commit, history, passageId, onOpenPassage }: {
  workspace: Workspace; commit: Commit; history: OperationBatch[]; passageId?: string; onOpenPassage: (id: string) => void;
}) {
  const passage = w.passages.find(item => item.id === passageId);
  const style = styleProfile(w);
  const companion = useCompanion();
  const update = (patch: Patch, label: string) => commit(current => [{ type: 'updateStyle', patch: patch(styleProfile(current)) }], label);
  const summon = (event: React.MouseEvent<HTMLElement>, focus: 'distill' | 'blindtest') => {
    const rect = event.currentTarget.getBoundingClientRect();
    const own = style.samples.some(sample => sample.source === 'own');
    companion.summon({ mode: 'style', screen: { x: rect.left, y: rect.bottom }, label: focus === 'distill' ? '提炼文风' : '文风盲测',
      anchor: { surface: 'style', references: [], focus, ...(focus === 'blindtest' && passage ? { sceneId: passage.sceneId, passageId: passage.id } : {}) },
      message: focus === 'blindtest' ? '用几种不同的笔法写同一段，让我挑最像我的。' : own ? '读读我的范文，帮我把文风说清楚。' : '我还没有范文，先问我几个问题，帮我找到自己的文风。' });
  };
  const done = [!!style.summary.trim(), style.samples.some(sample => sample.source === 'own'),
    Object.values(style.dials).filter(Boolean).length >= 3, style.rules.length + style.avoidWords.length > 0];
  return <div className="style-page">
    <section className="panel style-hero" aria-labelledby="style-title">
      <div className="section-heading">
        <div><h2 id="style-title">文风画像</h2><p className="muted">写作、改写和文风审阅都以这里为准。越具体，AI 越像你。</p></div>
        <span className="pill" title="画像、亲笔范文、至少 3 个笔调旋钮、规则或禁用词">完整度 {done.filter(Boolean).length} / {done.length}</span>
      </div>
      <Field className="style-summary" label="你的笔触" multiline value={style.summary} placeholder="例如：短句为主，动作先于心理；对白干脆，少用形容词；情绪从不直说，靠物件和停顿表现。"
        onSave={summary => update(() => ({ summary: summary.slice(0, STYLE_LIMITS.summary) }), '修改文风画像')}/>
      <div className="button-row panel-actions">
        <button className="secondary" data-testid="style-distill" onClick={event => summon(event, 'distill')}><Wand2 aria-hidden="true"/>{style.samples.length ? '从范文提炼文风' : '帮我找到文风'}</button>
        <button className="ghost" data-testid="style-blindtest" onClick={event => summon(event, 'blindtest')}><FlaskConical aria-hidden="true"/>文风盲测</button>
        {!done[1] && <span className="muted">贴一段你自己写的文字，是让 AI 认识你最快的方式。</span>}
      </div>
    </section>
    <div className="style-grid">
      <div className="style-main">
        <Dials style={style} update={update}/>
        <Samples workspace={w} style={style} update={update} onOpenPassage={onOpenPassage}/>
        <Fingerprints workspace={w} history={history}/>
      </div>
      <div className="style-side">
        <Learned workspace={w} style={style} update={update}/>
        <Rules style={style} update={update}/>
        <Voices workspace={w} style={style} update={update}/>
      </div>
    </div>
  </div>;
}

type Update = (patch: Patch, label: string) => Promise<unknown>;

function Dials({ style, update }: { style: StyleProfile; update: Update }) {
  const setPerson = (person: StylePerson | null) => fire(update(current => ({ dials: { ...current.dials, person } }), '调整叙述人称'));
  return <section className="panel" aria-labelledby="style-dials">
    <div className="section-heading"><div><h2 id="style-dials">笔调旋钮</h2><p className="muted">不确定的留空，写作者会以范文为准。</p></div></div>
    <div className="style-dial person">
      <span className="style-dial-label">叙述人称</span>
      <div className="segmented" role="group" aria-label="叙述人称">
        {(Object.keys(personNames) as StylePerson[]).map(person => <button key={person} className={style.dials.person === person ? 'active' : ''} aria-pressed={style.dials.person === person} onClick={() => setPerson(style.dials.person === person ? null : person)}>{personNames[person]}</button>)}
      </div>
    </div>
    {STYLE_SCALES.map(id => {
      const [label, low, high] = scaleNames[id], value = style.dials[id];
      return <div className="style-dial" key={id} data-testid={`style-dial-${id}`}>
        <span className="style-dial-label">{label}</span>
        <span className="style-dial-end">{low}</span>
        <div className="style-scale" role="radiogroup" aria-label={`${label}：${low}到${high}`}>
          {([1, 2, 3, 4, 5] as StyleScale[]).map(step => <button key={step} role="radio" aria-checked={value === step} title={`${step} / 5`} className={value === step ? 'active' : value && step < value ? 'filled' : ''}
            onClick={() => fire(update(current => ({ dials: { ...current.dials, [id]: current.dials[id] === step ? null : step } }), `调整${label}`))}><i/></button>)}
        </div>
        <span className="style-dial-end">{high}</span>
      </div>;
    })}
  </section>;
}

function Samples({ workspace: w, style, update, onOpenPassage }: { workspace: Workspace; style: StyleProfile; update: Update; onOpenPassage: (id: string) => void }) {
  const [adding, setAdding] = useState(false);
  const total = style.samples.reduce((sum, sample) => sum + sample.text.length, 0);
  const sorted = [...style.samples].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || Number(b.source === 'own') - Number(a.source === 'own'));
  return <section className="panel" aria-labelledby="style-samples">
    <div className="section-heading">
      <div><h2 id="style-samples">范文库</h2><p className="muted">写作时会挑最相关的几段作为示范。在正文里选中文字，也可以「设为范文」。</p></div>
      <button className="small" data-testid="style-add-sample" disabled={style.samples.length >= STYLE_LIMITS.samples} onClick={() => setAdding(true)}><Plus aria-hidden="true"/>添加范文</button>
    </div>
    {!sorted.length && <p className="muted inset">还没有范文。贴一段你最满意的文字，或你想学习的作家片段。</p>}
    <div className="style-samples">{sorted.map(sample => <article className={`style-sample ${sample.source}`} key={sample.id} data-testid="style-sample">
      <header>
        <span className={`pill ${sample.source === 'own' ? 'own' : ''}`}>{sample.source === 'own' ? '亲笔' : '参考'}</span>
        <strong title={sample.label}>{sample.label || '未命名范文'}</strong>
        <small>{sample.author ? `${sample.author} · ` : ''}{count(sample.text).toLocaleString()} 字</small>
        <span className="row-actions">
          <button className="icon-button ghost small" title={sample.pinned ? '取消置顶' : '置顶：写作时优先使用'} aria-label={sample.pinned ? '取消置顶' : '置顶'} onClick={() => fire(update(current => ({ samples: current.samples.map(item => item.id === sample.id ? { ...item, pinned: !item.pinned || undefined } : item) }), sample.pinned ? '取消置顶范文' : '置顶范文'))}>{sample.pinned ? <PinOff/> : <Pin/>}</button>
          <button className="icon-button ghost small text-danger" title="删除范文" aria-label="删除范文" onClick={() => fire(update(current => ({ samples: current.samples.filter(item => item.id !== sample.id) }), '删除范文'))}><Trash2/></button>
        </span>
      </header>
      <p className="style-passage">{sample.text}</p>
      {(() => { const from = w.passages.find(item => item.id === sample.passageId); return from && <button className="link-button" onClick={() => onOpenPassage(from.id)}>来自「{passageLabel(w, from)}」</button>; })()}
    </article>)}</div>
    {!!style.samples.length && <p className="muted style-quota">{style.samples.length} / {STYLE_LIMITS.samples} 段 · 共 {total.toLocaleString()} / {STYLE_LIMITS.samplesTotal.toLocaleString()} 字</p>}
    {adding && <SampleDialog remaining={STYLE_LIMITS.samplesTotal - total} onClose={() => setAdding(false)}
      onSave={sample => update(current => ({ samples: [...current.samples, { id: uid(), ...sample }] }), '添加范文').then(() => setAdding(false))}/>}
  </section>;
}

function SampleDialog({ remaining, onClose, onSave }: { remaining: number; onClose: () => void; onSave: (sample: { label: string; text: string; source: 'own' | 'reference'; author?: string }) => Promise<unknown> }) {
  const [source, setSource] = useState<'own' | 'reference'>('own');
  const [label, setLabel] = useState(''), [author, setAuthor] = useState(''), [text, setText] = useState(''), [busy, setBusy] = useState(false);
  const limit = Math.min(STYLE_LIMITS.sampleChars, remaining), body = text.trim();
  return <Dialog title="添加范文" onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); if (!body || body.length > limit) return; setBusy(true);
      fire(onSave({ label: label.trim() || body.slice(0, 16), text: body, source, ...(source === 'reference' && author.trim() ? { author: author.trim() } : {}) }).finally(() => setBusy(false))); }}>
      <div className="segmented settings-mode" role="group" aria-label="范文来源">
        <button type="button" className={source === 'own' ? 'active' : ''} aria-pressed={source === 'own'} onClick={() => setSource('own')}>我写的</button>
        <button type="button" className={source === 'reference' ? 'active' : ''} aria-pressed={source === 'reference'} onClick={() => setSource('reference')}>参考其他作家</button>
      </div>
      {source === 'reference' && <p className="muted">参考范文只用来学习节奏、句法与描写方式，写作者被明确要求不复用其中的人物、情节与句子。</p>}
      <div className="form-grid"><label className="field"><span>标题（可选）</span><input data-testid="style-sample-label" value={label} maxLength={80} onChange={event => setLabel(event.target.value)} placeholder="例如：雨夜追逐"/></label>
        {source === 'reference' && <label className="field"><span>作者 / 出处</span><input value={author} maxLength={80} onChange={event => setAuthor(event.target.value)} placeholder="例如：汪曾祺《受戒》"/></label>}</div>
      <label className="field"><span>范文 <small>{body.length.toLocaleString()} / {limit.toLocaleString()} 字</small></span>
        <textarea data-testid="style-sample-text" rows={9} value={text} onChange={event => setText(event.target.value)} placeholder="贴一段 300 字以上的文字效果最好。"/></label>
      {body.length > limit && <p className="field-error" role="alert">超出 {(body.length - limit).toLocaleString()} 字，请截取最有代表性的部分。</p>}
      <div className="button-row"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" data-testid="style-save-sample" disabled={!body || body.length > limit || busy}>保存范文</button></div>
    </form>
  </Dialog>;
}

const metrics: Array<{ label: string; value: (f: StyleFingerprint) => number; unit: string; hint?: string }> = [
  { label: '平均句长', value: f => f.avgSentence, unit: '字' },
  { label: '短句占比', value: f => Math.round(f.shortRatio * 100), unit: '%', hint: '不超过 8 字的句子' },
  { label: '对白占比', value: f => Math.round(f.dialogueRatio * 100), unit: '%' },
  { label: '平均段长', value: f => f.avgParagraph, unit: '字' },
  { label: '比喻', value: f => f.simile, unit: '/千字' },
  { label: '四字短句', value: f => f.fourChar, unit: '/千字' },
  { label: '「×地」副词', value: f => f.adverb, unit: '/千字' },
  { label: 'AI 腔套话', value: f => f.cliche, unit: '/万字' },
];

function Fingerprints({ workspace: w, history }: { workspace: Workspace; history: OperationBatch[] }) {
  const { columns, fit } = useMemo(() => {
    const style = styleProfile(w), authored = authoredPassages(w, history), passages = orderedPassages(w).filter(passage => passage.text.trim());
    const join = (items: typeof passages) => items.map(passage => passage.text).join('\n').slice(-SAMPLE_TAIL);
    const own = style.samples.filter(sample => sample.source === 'own').map(sample => sample.text).join('\n');
    const mine = join(passages.filter(passage => authored.has(passage.id))), ai = join(passages.filter(passage => !authored.has(passage.id)));
    const columns = [
      { label: '亲笔范文', fingerprint: count(own) >= 100 ? styleFingerprint(own) : null },
      { label: '你写的正文', fingerprint: count(mine) >= 100 ? styleFingerprint(mine) : null },
      { label: 'AI 写的正文', fingerprint: count(ai) >= 100 ? styleFingerprint(ai) : null },
    ];
    return { columns, fit: count(ai) >= 300 ? styleLint(ai, style, styleBaseline(style, mine)) : null };
  }, [w, history]);
  const shown = columns.filter(column => column.fingerprint);
  return <section className="panel" aria-labelledby="style-fingerprint">
    <div className="section-heading">
      <div><h2 id="style-fingerprint">文风指纹</h2><p className="muted">本地统计，不消耗 token。看 AI 的正文离你的笔触有多远。</p></div>
      {fit && <span className={`pill ${fit.score >= 80 ? 'good' : fit.score >= 60 ? 'fair' : 'poor'}`} title="AI 正文与你的文风设定的贴合度（本地估算）">AI 贴合度 {fit.score}</span>}
    </div>
    {!shown.length ? <p className="muted inset">有了范文或正文后，这里会显示句长、对白、修辞等对比。</p> : <table className="style-metrics" data-testid="style-fingerprint">
      <thead><tr><th scope="col">指标</th>{shown.map(column => <th scope="col" key={column.label}>{column.label}<small>{column.fingerprint!.chars.toLocaleString()} 字</small></th>)}</tr></thead>
      <tbody>{metrics.map(metric => {
        const values = shown.map(column => metric.value(column.fingerprint!)), max = Math.max(...values, 0.0001);
        return <tr key={metric.label}><th scope="row" title={metric.hint}>{metric.label}</th>{values.map((value, index) => <td key={index}>
          <span className="style-bar"><i style={{ width: `${Math.max(2, value / max * 100)}%` }}/></span><span className="style-value">{value}<small>{metric.unit}</small></span></td>)}</tr>;
      })}</tbody>
    </table>}
    {!!fit?.issues.length && <details className="style-issues"><summary>AI 正文的文风问题 · {fit.issues.length} 项</summary><ul>{fit.issues.map((issue, index) => <li key={index}>{issue.message}{issue.excerpt && <q>{issue.excerpt}</q>}</li>)}</ul></details>}
  </section>;
}

function WordList({ label, words, testId, placeholder, onChange }: { label: string; words: string[]; testId: string; placeholder: string; onChange: (words: string[]) => Promise<unknown> }) {
  const [draft, setDraft] = useState('');
  const add = () => { const next = draft.split(/[、，,；;\s]+/).map(word => word.trim()).filter(word => word && word.length <= 40); if (!next.length) return; fire(onChange([...new Set([...words, ...next])].slice(0, STYLE_LIMITS.words)).then(() => setDraft(''))); };
  return <div className="field style-words"><span>{label}</span>
    <div className="chips">{words.map(word => <span className="chip" key={word}>{word}<button className="chip-remove" aria-label={`移除${word}`} onClick={() => fire(onChange(words.filter(item => item !== word)))}><X/></button></span>)}
      <input data-testid={testId} className="chip-input" value={draft} placeholder={placeholder} onChange={event => setDraft(event.target.value)} onBlur={add}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }}/></div>
  </div>;
}

function Rules({ style, update }: { style: StyleProfile; update: Update }) {
  const [draft, setDraft] = useState(''), [kind, setKind] = useState<'do' | 'avoid'>('do');
  const add = () => { const content = draft.trim(); if (!content) return; fire(update(current => ({ rules: current.rules.some(rule => rule.content === content) ? current.rules : [...current.rules, { id: uid(), kind, content, origin: 'author' }] }), '添加文风规则').then(() => setDraft(''))); };
  return <section className="panel" aria-labelledby="style-rules">
    <div className="section-heading"><div><h2 id="style-rules">规则与词表</h2><p className="muted">写作者必须遵守，文风审阅也按它检查。</p></div></div>
    {(['do', 'avoid'] as const).map(type => { const list = style.rules.filter(rule => rule.kind === type); return list.length ? <ul className={`style-rules ${type}`} key={type} aria-label={type === 'do' ? '要这样写' : '避免这样写'}>
      {list.map(rule => <li key={rule.id}><span className="style-rule-kind">{type === 'do' ? '要' : '不要'}</span><span>{rule.content}{rule.origin !== 'author' && <small> · 来自{originNames[rule.origin]}</small>}</span>
        <button className="icon-button ghost small" aria-label="删除规则" title="删除规则" onClick={() => fire(update(current => ({ rules: current.rules.filter(item => item.id !== rule.id) }), '删除文风规则'))}><X/></button></li>)}
    </ul> : null; })}
    <form className="style-rule-form" onSubmit={event => { event.preventDefault(); add(); }}>
      <div className="segmented" role="group" aria-label="规则类型"><button type="button" className={kind === 'do' ? 'active' : ''} aria-pressed={kind === 'do'} onClick={() => setKind('do')}>要</button><button type="button" className={kind === 'avoid' ? 'active' : ''} aria-pressed={kind === 'avoid'} onClick={() => setKind('avoid')}>不要</button></div>
      <input data-testid="style-rule-input" value={draft} maxLength={300} onChange={event => setDraft(event.target.value)} placeholder={kind === 'do' ? '例如：情绪靠动作和物件表现' : '例如：用“他沉声道”这类说话标签'}/>
      <button className="small" disabled={!draft.trim()}>添加</button>
    </form>
    <WordList label="禁用词" words={style.avoidWords} testId="style-avoid-input" placeholder="输入后回车，多个词用顿号分隔" onChange={avoidWords => update(() => ({ avoidWords }), '修改禁用词')}/>
    <WordList label="偏好词" words={style.preferWords} testId="style-prefer-input" placeholder="你常用、想保留的词" onChange={preferWords => update(() => ({ preferWords }), '修改偏好词')}/>
    <label className="checkbox-label"><input type="checkbox" checked={style.blockAiCliches} onChange={event => fire(update(() => ({ blockAiCliches: event.target.checked }), event.target.checked ? '屏蔽 AI 腔' : '不再屏蔽 AI 腔'))}/>屏蔽常见 AI 腔</label>
    <details className="style-cliches"><summary>查看 AI 腔词表</summary><div className="chips">{AI_CLICHES.map(item => <span key={item.phrase} className={`chip ${item.tier}`} title={item.tier === 'strong' ? '一律避免' : '少量可以，密集时提醒'}>{item.phrase}</span>)}</div></details>
  </section>;
}

function Voices({ workspace: w, style, update }: { workspace: Workspace; style: StyleProfile; update: Update }) {
  const cast = characters(w);
  return <section className="panel" aria-labelledby="style-voices">
    <div className="section-heading"><div><h2 id="style-voices">人物声音</h2><p className="muted">说话方式、口头禅、绝不会说的词。人物出场时写作者会照此写对白。</p></div></div>
    {!cast.length && <p className="muted inset">还没有人物。</p>}
    {cast.map(character => <Field key={character.id} label={character.name} multiline value={style.voices.find(voice => voice.characterId === character.id)?.voice ?? ''} placeholder="例如：说话短，爱反问；从不说“谢谢”，用玩笑带过。"
      onSave={value => update(current => ({ voices: [...current.voices.filter(voice => voice.characterId !== character.id), ...(value.trim() ? [{ characterId: character.id, voice: value.trim().slice(0, STYLE_LIMITS.voice) }] : [])] }), `修改${character.name}的声音`)}/>)}
  </section>;
}

function Learned({ workspace: w, style, update }: { workspace: Workspace; style: StyleProfile; update: Update }) {
  const [status, setStatus] = useState<StyleLearningStatus | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    window.novel.getStyleLearning(w.id).then(value => { if (alive) setStatus(value); }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); });
    const off = window.novel.onAgentEvent(event => { if (event.type === 'styleLearning' && event.projectId === w.id && event.style) setStatus(event.style); });
    return () => { alive = false; off(); };
  }, [w.id, w.revision]);
  const pending = style.suggestions.filter(item => item.status === 'pending'), dismissed = style.suggestions.length - pending.length;
  const adopt = (suggestion: StyleSuggestion) => fire(update(current => {
    const suggestions = current.suggestions.filter(item => item.id !== suggestion.id);
    if (suggestion.word) return { suggestions, [suggestion.word.list]: [...new Set([...current[suggestion.word.list], suggestion.word.value])] };
    return { suggestions, rules: current.rules.some(rule => rule.content === suggestion.content) ? current.rules
      : [...current.rules, { id: uid(), kind: suggestion.kind, content: suggestion.content, origin: suggestion.origin, ...(suggestion.evidence ? { evidence: suggestion.evidence } : {}) }] };
  }, '采纳文风建议'));
  const dismiss = (suggestion: StyleSuggestion) => fire(update(current => ({ suggestions: current.suggestions.map(item => item.id === suggestion.id ? { ...item, status: 'dismissed' as const } : item) }), '忽略文风建议'));
  const avoid = (word: string) => fire(update(current => ({ avoidWords: [...new Set([...current.avoidWords, word])] }), '加入禁用词'));
  const waiting = (status?.pendingEdits ?? 0) + (status?.pendingRejections ?? 0) + (status?.pendingChoices ?? 0);
  const learn = () => { setError(''); fire(window.novel.learnStyle(w.id).then(setStatus).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))); };
  return <section className="panel style-learned" aria-labelledby="style-learned">
    <div className="section-heading"><div><h2 id="style-learned">学到的偏好</h2><p className="muted">从你对 AI 正文的改稿、拒稿理由，以及在创作伙伴几个方案之间的取舍里学，采纳后才生效。</p></div></div>
    <div className="style-learn-bar">
      <span>{status ? waiting ? `${status.pendingEdits} 处改稿 · ${status.pendingRejections} 条拒稿理由 · ${status.pendingChoices} 次方案取舍待整理` : '暂无新的改稿可学习' : '正在统计…'}{status?.usage.provided ? ` · 本次启动用量 ${status.usage.total.toLocaleString()} tokens` : ''}</span>
      <button className="small" data-testid="style-learn" disabled={!waiting || status?.running} onClick={learn}>{status?.running ? <RefreshCw className="spin" aria-hidden="true"/> : <Sparkles aria-hidden="true"/>}{status?.running ? '整理中…' : '整理改稿偏好'}</button>
    </div>
    {!!status?.deletedWords.length && <div className="style-deleted"><span className="muted">你常删掉：</span><div className="chips">{status.deletedWords.map(item => <button key={item.word} className="chip" title="加入禁用词" onClick={() => avoid(item.word)}>{item.word}<small>×{item.count}</small><Plus aria-hidden="true"/></button>)}</div></div>}
    {(error || status?.lastError) && <p className="field-error" role="alert">{error || status?.lastError}</p>}
    {!pending.length ? <p className="muted inset">{style.suggestions.length ? '建议都处理完了。' : '先用 AI 写几段，按你的习惯改一改，再回来整理。'}</p>
      : <ul className="style-suggestions">{pending.map(suggestion => <li key={suggestion.id} data-testid="style-suggestion">
        <div><span className="pill">{originNames[suggestion.origin]}</span><strong>{suggestion.word ? `${suggestion.word.list === 'avoidWords' ? '禁用' : '偏好'}「${suggestion.word.value}」` : `${suggestion.kind === 'do' ? '要' : '不要'}：${suggestion.content}`}</strong></div>
        {suggestion.evidence && <p className="muted">{suggestion.evidence}</p>}
        <div className="button-row"><button className="small primary" data-testid="style-adopt-suggestion" onClick={() => adopt(suggestion)}><Check aria-hidden="true"/>采纳</button><button className="small ghost" onClick={() => dismiss(suggestion)}>忽略</button></div>
      </li>)}</ul>}
    {dismissed > 0 && <p className="muted style-quota"><BookMarked aria-hidden="true"/>已忽略 {dismissed} 条</p>}
  </section>;
}
