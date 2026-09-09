import './App.css';
import { bitable, IFieldMeta, ITable } from '@lark-base-open/js-sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';

type Logic = 'and' | 'or';
type KolRecord = { id: string; name: string; collaborated: string; language: string; contentType: string; collaborationType: string; region: string; avgViews: number | null; searchable: string; };
type ParsedQuery = { logic: Logic; head: boolean; collaborated: boolean; english: boolean; western: boolean; varietyGaming: boolean; dedicated: boolean; rokSuitable: boolean; minViews: number | null; freeTerms: string[]; };

const FIELD_NAMES = ['达人姓名', '是否合作过', '语言', '内容类型', '合作类型', '近30天平均播放量', '所属地区'] as const;
const WESTERN_REGIONS = ['美国', '英国', '加拿大', '澳大利亚', '新西兰', '爱尔兰', '法国', '西班牙', '瑞典', '荷兰', '比利时', '智利', '阿根廷', '地区待确认（英语）'];
const ROK_CONTENT_TYPES = ['泛游戏/游戏娱乐', '游戏攻略/评测', 'Minecraft/Roblox', '真人娱乐/生活'];
const EXAMPLES = [
  '头部网红，合作过的，能和 Rise of Kingdom 做推广',
  '欧美地区网红，英语，杂食类游戏博主',
  '能做整片的英语头部网红',
];

const normalize = (value: string) => value.toLowerCase().replace(/[，。；、,.!！?？()（）\s/_-]+/g, ' ').trim();
const parseNumber = (value: string): number | null => {
  const match = value.replace(/,/g, '').trim().match(/([0-9]+(?:\.[0-9]+)?)\s*(万|w|k|m)?/i);
  if (!match) return null;
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === '万' || unit === 'w' ? 10_000 : unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1;
  return Number(match[1]) * multiplier;
};

function parseQuery(input: string): ParsedQuery {
  const text = normalize(input);
  const thresholdMatch = text.match(/(?:播放|播放量|平均播放量)?\s*(?:大于|超过|不少于|至少|>=?)\s*([0-9,.]+\s*(?:万|w|k|m)?)/i);
  const knownFragments = [
    /头部|大网红|top\s*creator/gi, /合作过|已合作|历史合作/gi, /英语|英文|english/gi,
    /欧美|北美|欧洲|western/gi, /杂食(?:类)?游戏|泛游戏|游戏娱乐|variety\s*gaming/gi,
    /整片|专属视频|dedicated(?:\s*video)?/gi, /rise\s*of\s*kingdoms?|万国觉醒|rok/gi,
    /网红|达人|博主|主播|创作者|推广|能做|适合|的/gi,
    /播放|播放量|平均播放量|大于|超过|不少于|至少|万|w|k|m|[0-9,.]+/gi,
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
    rokSuitable: /rise\s*of\s*kingdoms?|万国觉醒|\brok\b/.test(text),
    minViews: thresholdMatch ? parseNumber(thresholdMatch[1]) : null,
    freeTerms: remainder.split(/\s+/).filter((term) => term.length > 1),
  };
}

const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)];
};
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

export default function App() {
  const [query, setQuery] = useState(EXAMPLES[0]);
  const [records, setRecords] = useState<KolRecord[]>([]);
  const [table, setTable] = useState<ITable | null>(null);
  const [fieldMap, setFieldMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hasSearched, setHasSearched] = useState(false);

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
          region: cells['所属地区'], avgViews: parseNumber(cells['近30天平均播放量']),
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
  const headThreshold = useMemo(() => quantile(records.flatMap((record) => record.avgViews == null ? [] : [record.avgViews]), .8), [records]);
  const results = useMemo(() => {
    if (!hasSearched) return [];
    return records.filter((record) => {
      const conditions: boolean[] = [];
      const minViews = parsed.minViews ?? (parsed.head ? headThreshold : null);
      if (minViews != null) conditions.push(record.avgViews != null && record.avgViews >= minViews);
      if (parsed.collaborated) conditions.push(normalize(record.collaborated).includes('是'));
      if (parsed.english) conditions.push(normalize(record.language).includes('英语'));
      if (parsed.western) conditions.push(includesAny(record.region, WESTERN_REGIONS));
      if (parsed.varietyGaming) conditions.push(normalize(record.contentType).includes('泛游戏'));
      if (parsed.dedicated) conditions.push(/dedicated|整片|专属/i.test(record.collaborationType));
      if (parsed.rokSuitable) conditions.push(includesAny(record.contentType, ROK_CONTENT_TYPES));
      parsed.freeTerms.forEach((term) => conditions.push(fuzzyContains(record.searchable, term)));
      if (!conditions.length) return fuzzyContains(record.searchable, query);
      return parsed.logic === 'or' ? conditions.some(Boolean) : conditions.every(Boolean);
    }).sort((a, b) => (b.avgViews ?? -1) - (a.avgViews ?? -1));
  }, [hasSearched, records, parsed, headThreshold, query]);

  const recognized = [
    parsed.head && `头部 ≥ ${headThreshold?.toLocaleString() ?? '暂无阈值'}播放`,
    parsed.minViews != null && `播放量 ≥ ${parsed.minViews.toLocaleString()}`,
    parsed.collaborated && '合作过', parsed.english && '英语', parsed.western && '欧美地区',
    parsed.varietyGaming && '泛游戏/游戏娱乐', parsed.dedicated && '支持整片 Dedicated',
    parsed.rokSuitable && '适合 ROK（游戏内容）', ...parsed.freeTerms.map((term) => `包含“${term}”`),
  ].filter(Boolean) as string[];

  const openRecord = async (recordId: string) => {
    if (!table) return;
    await bitable.ui.showRecordDetailDialog({ tableId: table.id, recordId, fieldIdList: FIELD_NAMES.map((name) => fieldMap[name]).filter(Boolean) });
  };

  return (
    <main className="app-shell">
      <header className="hero"><div><p className="eyebrow">KOL DISCOVERY</p><h1>智能筛选</h1><p className="subtitle">用一句话，从当前视图找到合适的达人</p></div><button className="icon-button" onClick={() => void loadRecords()} title="刷新数据">↻</button></header>
      <section className="query-panel">
        <textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：欧美地区、英语、能做整片的头部游戏达人" rows={4} />
        <button className="primary-button" disabled={loading || !query.trim()} onClick={() => setHasSearched(true)}>{loading ? '读取数据中…' : '开始筛选'}</button>
      </section>
      <section className="examples"><span>试试这些：</span>{EXAMPLES.map((example) => <button key={example} onClick={() => { setQuery(example); setHasSearched(false); }}>{example}</button>)}</section>
      {error && <div className="status error">{error}</div>}
      {recognized.length > 0 && <section className="interpretation"><div className="section-heading"><h2>已识别条件</h2><span>{parsed.logic === 'and' ? '全部满足' : '满足任一'}</span></div><div className="chips">{recognized.map((item) => <span key={item}>{item}</span>)}</div>{parsed.rokSuitable && <p className="hint">ROK 适配度目前依据内容类型推断，不代表达人已推广过该游戏。</p>}</section>}
      {hasSearched && !loading && !error && <section className="results"><div className="section-heading"><h2>筛选结果</h2><span>{results.length} / {records.length}</span></div>{results.length === 0 ? <div className="empty">没有同时满足条件的达人，可以减少一个条件再试。</div> : results.map((record) => <button className="result-card" key={record.id} onClick={() => void openRecord(record.id)}><div className="record-title"><strong>{record.name}</strong><span>{record.avgViews == null ? '播放量待补充' : `${record.avgViews.toLocaleString()} 播放`}</span></div><div className="record-meta">{record.region} · {record.language} · {record.contentType}</div><div className="record-meta">{record.collaborationType} · 合作过：{record.collaborated || '未知'}</div></button>)}</section>}
    </main>
  );
}
