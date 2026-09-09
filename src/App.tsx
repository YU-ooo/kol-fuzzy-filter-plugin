import './App.css';
import { bitable, IFieldMeta, IOpenLink, ITable } from '@lark-base-open/js-sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';

type Logic = 'and' | 'or';
type KolRecord = { id: string; name: string; collaborated: string; language: string; contentType: string; collaborationType: string; region: string; recommendationTag: string; recommendationReason: string; accountLink: string; videoLink: string; quote: string; cpm: string; followers: number | null; avgViews: number | null; searchable: string; };
type ParsedQuery = { logic: Logic; head: boolean; collaborated: boolean; english: boolean; western: boolean; varietyGaming: boolean; dedicated: boolean; integration: boolean; rokSuitable: boolean; minFollowers: number | null; minViews: number | null; freeTerms: string[]; };

const FIELD_NAMES = ['达人姓名', '是否合作过', '语言', '内容类型', '合作类型', '粉丝数', '近30天平均播放量', '所属地区', '推荐标签', '推荐理由', '账号链接', '视频链接', '报价', 'CPM'] as const;
const HEAD_FOLLOWERS = 1_000_000;
const WESTERN_REGIONS = ['美国', '英国', '加拿大', '澳大利亚', '新西兰', '爱尔兰', '法国', '西班牙', '瑞典', '荷兰', '比利时', '智利', '阿根廷', '地区待确认（英语）'];
const ROK_CONTENT_TYPES = ['泛游戏/游戏娱乐', '游戏攻略/评测'];
const ROK_EXCLUDED_TYPES = ['Minecraft/Roblox', '宝可梦/任天堂'];
const ROK_EXACT_KEYWORDS = ['rise of kingdoms', 'riseofkingdoms', '万国觉醒', 'rok'];
const ROK_POSITIVE_KEYWORDS = ['slg', '4x', '策略游戏', '战争策略', '战争游戏', '帝国', '文明', '历史游戏', '手游', '手机游戏', 'mobile game', 'strategy game'];
const ROK_NEGATIVE_KEYWORDS = ['minecraft', 'roblox', '宝可梦', 'pokemon', '任天堂', 'nintendo', '少儿', '儿童向'];
const normalize = (value: string) => value.toLowerCase().replace(/[，。；、,.!！?？()（）\s/_-]+/g, ' ').trim();
const parseNumber = (value: string): number | null => {
  const match = value.replace(/,/g, '').trim().match(/([0-9]+(?:\.[0-9]+)?)\s*(亿|万|w|k|m)?/i);
  if (!match) return null;
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === '亿' ? 100_000_000 : unit === '万' || unit === 'w' ? 10_000 : unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1;
  return Number(match[1]) * multiplier;
};

function parseQuery(input: string): ParsedQuery {
  const text = normalize(input.replace(/(?<=\d),(?=\d)/g, ''));
  const comparator = '(?:大于|高于|超过|超|不少于|至少|达到|≥|>=|>)';
  const number = '([0-9][0-9,.]*\\s*(?:亿|万|w|k|m)?)';
  const followerMatch = text.match(new RegExp(`(?:粉丝(?:数|量)?|followers?|fans?|订阅(?:数|量)?|subscribers?|subs?)\\s*${comparator}\\s*${number}`, 'i'));
  const viewMatch = text.match(new RegExp(`(?:近\\s*30\\s*天)?(?:平均)?(?:播放(?:数|量)?|观看(?:数|量)?|views?)\\s*${comparator}\\s*${number}`, 'i'));
  const knownFragments = [
    /头部|大网红|top\s*creator/gi, /合作过|已合作|历史合作/gi, /英语|英文|english/gi,
    /欧美|北美|欧洲|western/gi, /杂食(?:类)?游戏|泛游戏|游戏娱乐|variety\s*gaming/gi,
    /整片|专属视频|dedicated(?:\s*video)?/gi, /贴片|植入|integrated|integration/gi, /rise\s*of\s*kingdoms?|万国觉醒|rok/gi,
    /网红|达人|博主|主播|创作者|推广|能做|适合|的/gi,
    /粉丝数?|粉丝量|followers?|fans?|订阅数?|订阅量|subscribers?|subs?|播放|播放量|平均播放量|观看数?|观看量|views?|大于|高于|超过|超|不少于|至少|达到|亿|万|w|k|m|[0-9,.]+|≥|>=|>/gi,
    /并且|同时|以及|且|和|、|，|,/gi,
  ];
  let remainder = text;
  knownFragments.forEach((pattern) => { remainder = remainder.replace(pattern, ' '); });
  return {
    logic: /任一|或者|满足一条/.test(text) ? 'or' : 'and',
    head: /头部|大网红|top\s*creator/.test(text),
    collaborated: /合作过|已合作|历史合作/.test(text),
    english: /英语|英文|english/.test(text),
    western: /欧美|北美|欧洲|western/.test(text),
    varietyGaming: /杂食(?:类)?游戏|泛游戏|游戏娱乐|variety\s*gaming/.test(text),
    dedicated: /整片|专属视频|dedicated(?:\s*video)?/.test(text),
    integration: /贴片|植入|integrated|integration/.test(text),
    rokSuitable: /rise\s*of\s*kingdoms?|万国觉醒|\brok\b/.test(text),
    minFollowers: followerMatch ? parseNumber(followerMatch[1]) : null,
    minViews: viewMatch ? parseNumber(viewMatch[1]) : null,
    freeTerms: remainder.split(/\s+/).filter((term) => term.length > 1),
  };
}

const includesAny = (value: string, options: string[]) => options.some((option) => normalize(value).includes(normalize(option)));
const editDistance = (left: string, right: string) => {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[right.length];
};
const fuzzyContains = (value: string, term: string) => {
  const haystack = normalize(value);
  const needle = normalize(term);
  if (haystack.includes(needle)) return true;
  const tolerance = needle.length >= 8 ? 2 : needle.length >= 4 ? 1 : 0;
  return tolerance > 0 && haystack.split(' ').some((token) => editDistance(token, needle) <= tolerance);
};

const assessRok = (record: KolRecord) => {
  let score = 0;
  const reasons: string[] = [];
  const reasonText = normalize(record.recommendationReason);
  const exactMatch = includesAny(reasonText, ROK_EXACT_KEYWORDS);
  if (includesAny(record.contentType, ROK_CONTENT_TYPES)) { score += 2; reasons.push('内容类型匹配'); }
  if (includesAny(record.contentType, ROK_EXCLUDED_TYPES)) { score -= 3; reasons.push('强垂类受众'); }
  if (/优先推荐/.test(record.recommendationTag)) { score += 2; reasons.push('优先推荐'); }
  else if (/^推荐$/.test(record.recommendationTag.trim())) { score += 1; reasons.push('推荐'); }
  else if (/谨慎/.test(record.recommendationTag)) { score -= 2; reasons.push('谨慎合作'); }
  if (exactMatch) { score += 4; reasons.push('理由提及 ROK'); }
  else if (includesAny(reasonText, ROK_POSITIVE_KEYWORDS)) { score += 2; reasons.push('理由含策略/手游信号'); }
  if (includesAny(reasonText, ROK_NEGATIVE_KEYWORDS)) { score -= 3; reasons.push('理由含不匹配信号'); }
  return { score, suitable: score >= 2, reasons };
};

export default function App() {
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState<KolRecord[]>([]);
  const [table, setTable] = useState<ITable | null>(null);
  const [fieldMap, setFieldMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const selection = await bitable.base.getSelection();
      if (!selection.tableId) throw new Error('请先在多维表格中打开一张数据表');
      const activeTable = await bitable.base.getTableById(selection.tableId);
      const metas = await activeTable.getFieldMetaList();
      const map = Object.fromEntries(metas.filter((meta: IFieldMeta) => FIELD_NAMES.includes(meta.name as typeof FIELD_NAMES[number])).map((meta: IFieldMeta) => [meta.name, meta.id]));
      const missing = FIELD_NAMES.filter((name) => !map[name]);
      if (missing.length) throw new Error(`当前表缺少字段：${missing.join('、')}`);

      let recordIds: string[];
      if (selection.viewId) {
        const view = await activeTable.getViewById(selection.viewId);
        recordIds = (await view.getVisibleRecordIdList()).filter((id): id is string => Boolean(id));
      } else {
        recordIds = [...await activeTable.getRecordList()].map((record) => record.id);
      }
      const rows = await Promise.all(recordIds.map(async (id): Promise<KolRecord> => {
        const values = await Promise.all(FIELD_NAMES.map((name) => activeTable.getCellString(map[name], id)));
        const cells = Object.fromEntries(FIELD_NAMES.map((name, index) => [name, values[index] ?? '']));
        return {
          id, name: cells['达人姓名'] || '未命名达人', collaborated: cells['是否合作过'],
          language: cells['语言'], contentType: cells['内容类型'], collaborationType: cells['合作类型'],
          region: cells['所属地区'], recommendationTag: cells['推荐标签'], recommendationReason: cells['推荐理由'],
          accountLink: cells['账号链接'], videoLink: cells['视频链接'], quote: cells['报价'], cpm: cells['CPM'],
          followers: parseNumber(cells['粉丝数']), avgViews: parseNumber(cells['近30天平均播放量']),
          searchable: normalize(values.join(' ')),
        };
      }));
      setTable(activeTable);
      setFieldMap(map);
      setRecords(rows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取多维表格失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadRecords(); }, [loadRecords]);
  const parsed = useMemo(() => parseQuery(query), [query]);
  const results = useMemo(() => {
    if (!hasSearched) return [];
    return records.filter((record) => {
      const conditions: boolean[] = [];
      const minFollowers = parsed.minFollowers ?? (parsed.head ? HEAD_FOLLOWERS : null);
      if (minFollowers != null) conditions.push(record.followers != null && record.followers >= minFollowers);
      if (parsed.minViews != null) conditions.push(record.avgViews != null && record.avgViews >= parsed.minViews);
      if (parsed.collaborated) conditions.push(normalize(record.collaborated).includes('是'));
      if (parsed.english) conditions.push(normalize(record.language).includes('英语'));
      if (parsed.western) conditions.push(includesAny(record.region, WESTERN_REGIONS));
      if (parsed.varietyGaming) conditions.push(normalize(record.contentType).includes('泛游戏'));
      if (parsed.dedicated) conditions.push(/dedicated|整片|专属/i.test(record.collaborationType));
      if (parsed.integration) conditions.push(/integrated|integration|贴片|植入/i.test(record.collaborationType));
      if (parsed.rokSuitable) conditions.push(assessRok(record).suitable);
      parsed.freeTerms.forEach((term) => conditions.push(fuzzyContains(record.searchable, term)));
      if (!conditions.length) return fuzzyContains(record.searchable, query);
      return parsed.logic === 'or' ? conditions.some(Boolean) : conditions.every(Boolean);
    }).sort((a, b) => parsed.rokSuitable
      ? assessRok(b).score - assessRok(a).score || (b.avgViews ?? -1) - (a.avgViews ?? -1)
      : (b.avgViews ?? -1) - (a.avgViews ?? -1));
  }, [hasSearched, records, parsed, query]);

  const recognized = [
    parsed.head && `头部（粉丝 ≥ ${HEAD_FOLLOWERS.toLocaleString()}）`,
    parsed.minFollowers != null && `粉丝数 ≥ ${parsed.minFollowers.toLocaleString()}`,
    parsed.minViews != null && `播放量 ≥ ${parsed.minViews.toLocaleString()}`,
    parsed.collaborated && '合作过', parsed.english && '英语', parsed.western && '欧美地区',
    parsed.varietyGaming && '泛游戏/游戏娱乐', parsed.dedicated && '整片 Dedicated', parsed.integration && '贴片 Integration',
    parsed.rokSuitable && 'ROK 综合适配评分 ≥ 2', ...parsed.freeTerms.map((term) => `包含“${term}”`),
  ].filter(Boolean) as string[];

  const openRecord = async (recordId: string) => {
    if (!table) return;
    await bitable.ui.showRecordDetailDialog({ tableId: table.id, recordId, fieldIdList: FIELD_NAMES.map((name) => fieldMap[name]).filter(Boolean) });
  };

  const toggleSelected = (recordId: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(recordId)) next.delete(recordId); else next.add(recordId);
    return next;
  });

  const saveSelection = async () => {
    if (!table || selectedIds.size === 0) return;
    setSaving(true);
    setSaveMessage('');
    try {
      const shortlist = await bitable.base.getTableByName('达人筛选清单');
      const [batchField, talentField, queryField] = await Promise.all([
        shortlist.getField('筛选批次'), shortlist.getField('达人'), shortlist.getField('筛选条件'),
      ]);
      const batchName = `智能筛选 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
      await Promise.all([...selectedIds].map(async (recordId) => {
        const source = records.find((record) => record.id === recordId);
        if (!source) return;
        const newRecordId = await shortlist.addRecord();
        const linkValue: IOpenLink = { text: source.name, type: 'text', recordIds: [recordId], tableId: table.id, record_ids: [recordId], table_id: table.id };
        await Promise.all([
          batchField.setValue(newRecordId, batchName),
          talentField.setValue(newRecordId, linkValue),
          queryField.setValue(newRecordId, query),
        ]);
      }));
      setSaveMessage(`已将 ${selectedIds.size} 位达人加入“达人筛选清单”，报价等字段会自动同步。`);
      setSelectedIds(new Set());
    } catch (cause) {
      setSaveMessage(cause instanceof Error ? `保存失败：${cause.message}` : '保存失败，请确认当前用户有编辑权限。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="hero"><div><p className="eyebrow">KOL DISCOVERY</p><h1>智能筛选</h1><p className="subtitle">用一句话，从当前视图找到合适的达人</p></div><button className="icon-button" onClick={() => void loadRecords()} title="刷新数据">↻</button></header>
      <section className="query-panel">
        <textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：欧美地区、英语、能做整片的头部游戏达人" rows={4} />
        <button className="primary-button" disabled={loading || !query.trim()} onClick={() => setHasSearched(true)}>{loading ? '读取数据中…' : '开始筛选'}</button>
      </section>
      {error && <div className="status error">{error}</div>}
      {recognized.length > 0 && <section className="interpretation"><div className="section-heading"><h2>已识别条件</h2><span>{parsed.logic === 'and' ? '全部满足' : '满足任一'}</span></div><div className="chips">{recognized.map((item) => <span key={item}>{item}</span>)}</div>{parsed.head && <p className="hint">“头部”当前明确定义为粉丝数不少于 100 万。</p>}{parsed.rokSuitable && <p className="hint">ROK 综合内容类型、推荐标签和推荐理由评分；强垂类与“谨慎”会降分，理由明确提及 ROK、SLG、策略或手游会加分。</p>}</section>}
      {hasSearched && !loading && !error && <section className="results"><div className="section-heading"><h2>筛选结果</h2><span>{results.length} / {records.length}</span></div>{results.length > 0 && <div className="selection-bar"><button onClick={() => setSelectedIds(selectedIds.size === results.length ? new Set() : new Set(results.map((record) => record.id)))}>{selectedIds.size === results.length ? '清空选择' : '全选结果'}</button><button className="save-button" disabled={!selectedIds.size || saving} onClick={() => void saveSelection()}>{saving ? '保存中…' : `加入筛选清单（${selectedIds.size}）`}</button></div>}{saveMessage && <div className="save-message">{saveMessage}</div>}{results.length === 0 ? <div className="empty">没有同时满足条件的达人，可以减少一个条件再试。</div> : results.map((record) => { const rok = assessRok(record); return <article className={`result-card ${selectedIds.has(record.id) ? 'selected' : ''}`} key={record.id}><label className="select-control"><input type="checkbox" checked={selectedIds.has(record.id)} onChange={() => toggleSelected(record.id)} /><span>选择</span></label><button className="record-detail" onClick={() => void openRecord(record.id)}><div className="record-title"><strong>{record.name}</strong><span>{record.followers == null ? '粉丝数待补充' : `${record.followers.toLocaleString()} 粉丝`}</span></div><div className="record-meta">{record.region} · {record.language} · {record.contentType}</div><div className="record-meta">{record.collaborationType} · 合作过：{record.collaborated || '未知'} · {record.avgViews == null ? '播放量待补充' : `均播 ${record.avgViews.toLocaleString()}`}</div>{record.quote && <div className="record-reason">报价：{record.quote}</div>}{parsed.rokSuitable && <div className="record-reason">ROK {rok.score} 分 · {rok.reasons.join('、') || '暂无明确依据'}</div>}{record.recommendationReason && <div className="record-reason">推荐理由：{record.recommendationReason}</div>}</button></article>; })}</section>}
    </main>
  );
}
