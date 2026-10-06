import React, { useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { ArrowUpRight, ChartColumn, Lock, RefreshCw, Search, UserRound } from "lucide-react-native";
import {
  dashboardCardValue, dashboardMetrics, DASHBOARD_CARDS, DASHBOARD_DEFAULT, dcCount, dcValue, DIAGNOSIS, diagnosisBlock, diagnosisSentence,
  fansDistribution, fullTime, LIVE_TABS, listCount, listDuration, listMetricSet, listMetricsHidden, listRate, periodText, RADAR_AXES,
  STATUS_TONE, workStatus, WORK_STATUS_FILTER, WORK_TYPE_FILTER, GENDER_NAMES, type DiagnosisKey,
} from "../../domain/creatorCenter";
import { readCreator, type CreatorQuery } from "../../services/creatorCenter";
import type { ExploreConnection } from "../../services/explorer";
import { Bars, BarList, chartPalette, Donut, LineChart, Radar } from "./CreatorCharts";
import { clearCreatorCache, Empty, ErrorLine, kit, Loading, MetricTile, Panel, Segmented, SmallButton, Tabs, useCreator, type Raw } from "./CreatorKit";
import { CreatorWorkDetail } from "./CreatorWorkDetail";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";

type Props = { connection: ExploreConnection | null; collectorBusy: boolean; onOpenSettings: () => void; onOpenRecord: (url: string) => Promise<void> };
type View_ = "data" | "works";

const CREATOR_HOME = "https://creator.douyin.com/creator-micro/home";
const pad = (value: number) => String(value).padStart(2, "0");
const shortDate = (yyyymmdd: string) => `${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

export function CreatorWorkspace({ connection, collectorBusy, onOpenSettings, onOpenRecord }: Props) {
  const { width } = useWindowDimensions();
  const narrow = width < 760;
  const [view, setView] = useState<View_>("data");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const scrollRef = useRef<ScrollView | null>(null);
  const account = useCreator(connection, [{ key: "user_info" }]);
  const info = account.data?.[0] ?? null;
  const profile: Raw = info?.user_profile ?? info?.douyin_user_verify_info ?? {};
  const followers = Number(profile.follower_count ?? 0);
  useEffect(() => { setDetailId(null); }, [connection?.token]);
  const refresh = () => { clearCreatorCache(); setEpoch((value) => value + 1); account.reload(); };
  const openDetail = (id: string) => { setDetailId(id); scrollRef.current?.scrollTo({ y: 0, animated: false }); };

  if (!connection) return <View style={styles.root}><View style={styles.content}>
    <View {...ws("e-empty")} style={styles.gate}><ChartColumn size={34} color={color.accent} /><Text style={styles.gateTitle}>连接抖音，查看创作者数据</Text>
      <Text style={kit.body}>创作者中心的数据用的是采集器里登录的账号，只读不写。</Text><SmallButton label="前往连接" onPress={onOpenSettings} /></View>
  </View></View>;

  return <ScrollView ref={scrollRef} testID="creator-workspace" style={styles.root} contentContainerStyle={[styles.content, narrow && styles.contentNarrow]}>
    {collectorBusy ? <Text style={kit.muted}>采集器正在用浏览器读取记录，读完就能看创作者数据。</Text> : null}
    {account.error ? <ErrorLine text={account.error} onRetry={refresh} /> : null}
    {info ? <View {...ws("e-box")} style={styles.profile}>
      {profile.avatar_url ? <Image source={{ uri: profile.avatar_url }} accessibilityLabel="头像" style={styles.avatar} /> : <View style={[styles.avatar, styles.avatarEmpty]}><UserRound size={28} color={color.textMuted} /></View>}
      <View style={{ flex: 1, minWidth: 200, gap: 6 }}>
        <View style={kit.row}><Text style={styles.name}>{profile.nick_name ?? ""}</Text><Text style={kit.muted}>抖音号：{profile.unique_id ?? "-"}</Text></View>
        <Text style={kit.muted}>{profile.signature || "这个人很懒，没有留下任何签名"}</Text>
        <View style={kit.row}>
          <Text style={kit.muted}>关注 <Text style={kit.strong}>{dcCount(profile.following_count)}</Text></Text>
          <Text style={kit.muted}>粉丝 <Text style={kit.strong}>{dcCount(profile.follower_count)}</Text></Text>
          <Text style={kit.muted}>获赞 <Text style={kit.strong}>{dcCount(profile.total_favorited)}</Text></Text>
        </View>
      </View>
      <View style={kit.row}>
        <SmallButton label="刷新" onPress={refresh}><RefreshCw size={14} color={color.text} /></SmallButton>
        <SmallButton label="抖音创作者中心" onPress={() => void onOpenRecord(CREATOR_HOME)}><ArrowUpRight size={14} color={color.text} /></SmallButton>
      </View>
    </View> : account.loading ? <Loading label="正在读取创作者中心…" /> : null}

    {info && detailId ? <CreatorWorkDetail key={`${detailId}-${epoch}`} connection={connection} itemId={detailId} followers={followers} onBack={() => setDetailId(null)} /> : null}
    {info && !detailId ? <>
      <Tabs options={[{ label: "数据中心", value: "data" }, { label: "作品管理", value: "works" }]} value={view} onChange={setView} />
      {view === "data" ? <DataCenter key={epoch} connection={connection} info={info} followers={followers} onOpenWork={openDetail} onShowWorks={() => setView("works")} />
        : <WorkList key={epoch} connection={connection} onOpenWork={openDetail} />}
    </> : null}
  </ScrollView>;
}

// ---------------- 数据中心 ----------------

function DataCenter({ connection, info, followers, onOpenWork, onShowWorks }: { connection: ExploreConnection; info: Raw; followers: number; onOpenWork: (id: string) => void; onShowWorks: () => void }) {
  return <View style={{ gap: 18 }}>
    <Overview connection={connection} onOpenWork={onOpenWork} onShowWorks={onShowWorks} />
    <WorkData connection={connection} />
    {info.has_data_mgmt_perm ? <>
      <FansData connection={connection} />
      <FansPortrait connection={connection} followers={followers} />
    </> : null}
  </View>;
}

function Overview({ connection, onOpenWork, onShowWorks }: { connection: ExploreConnection; onOpenWork: (id: string) => void; onShowWorks: () => void }) {
  const [selected, setSelected] = useState<DiagnosisKey>("PlayCnt");
  const diag = useCreator(connection, [{ key: "diagnosis" }]);
  const data: Raw = diag.data?.[0]?.code === 0 ? diag.data[0].data ?? {} : {};
  const config = DIAGNOSIS.find((item) => item.key === selected)!;
  const topQuery: CreatorQuery[] = config.dimension
    ? [{ key: "contribution_top", params: { dimension: config.dimension, recent_days: 7 } }]
    : [{ key: "work_list", params: { status: 1, count: 12, max_cursor: 0 } }];
  const top = useCreator(connection, topQuery);
  const topItems = useMemo(() => {
    const payload = top.data?.[0];
    if (!payload) return null;
    if (config.dimension) return { ratio: payload.value_type === 2, items: (payload.items ?? []) as Raw[] };
    // 作品数：近 7 天发布的作品，按发布时间倒序取前三，值是播放量
    const since = Date.now() / 1000 - 7 * 86400;
    const list = ((payload.aweme_list ?? []) as Raw[]).filter((aweme) => Number(aweme.create_time) >= since)
      .sort((a, b) => Number(b.create_time) - Number(a.create_time)).slice(0, 3)
      .map((aweme) => ({ item_id: String(aweme.aweme_id), title: aweme.desc, cover: aweme.video?.cover, metric_value: Number(((payload.items ?? []) as Raw[]).find((item) => String(item.id) === String(aweme.aweme_id))?.metrics?.view_count) || 0 }));
    return { ratio: false, items: list };
  }, [top.data, config.dimension]);
  const sentence = diagnosisSentence(selected, data[selected]);
  const axisScale = RADAR_AXES.map((axis) => {
    const own = Number(data[axis.key]?.OwnValue ?? 0) || 0;
    const similar = Number(data[axis.key]?.SimilarValue ?? 0) || 0;
    const max = Math.max(own, similar) || 1;
    return { label: axis.label, own: own / max, similar: similar / max };
  });
  return <Panel title="数据总览" tip="对比您和同类作者在相同周期下的账号数据表现。同类作者：相似创作领域或粉丝量级的创作者" subtitle={`统计周期：${periodText(7)}（获取权限后次日起生产数据，每日12点更新）`}>
    {diag.error ? <ErrorLine text={diag.error} onRetry={diag.reload} /> : diag.loading ? <Loading /> : <View style={kit.columns}>
      <View style={[kit.column, { alignItems: "center" }]}>
        <View style={[kit.grid, { width: "100%" }]}>{DIAGNOSIS.map((item) => {
          const block = diagnosisBlock(item.key, data[item.key]);
          return <MetricTile key={item.key} label={block.label} value={block.value} note={block.rankText} tag={selected === item.key ? block.tag : null} selected={selected === item.key} onPress={() => setSelected(item.key)} />;
        })}</View>
        <Radar axes={axisScale} />
        <View style={kit.row}><View style={[styles.dot, { backgroundColor: chartPalette[0] }]} /><Text style={kit.muted}>我的指标</Text><View style={[styles.dot, { backgroundColor: color.textMuted }]} /><Text style={kit.muted}>同类作者</Text></View>
      </View>
      <View style={kit.column}>
        <Text style={kit.subhead}>{config.label}分析</Text>
        <View style={styles.sentence}><Text style={kit.body}>{sentence.parts.map((part, index) => <Text key={index} style={part.bold ? kit.strong : null}>{part.text}</Text>)}</Text></View>
        <View style={kit.between}><Text style={kit.subhead}>{selected === "PublishActivation" ? "近期作品" : `${config.label}贡献TOP3`}</Text>
          <Pressable accessibilityRole="button" onPress={onShowWorks}><Text style={kit.muted}>查看所有作品 ›</Text></Pressable></View>
        {top.error ? <Empty small text="加载失败，请稍后重试" /> : !topItems ? <Loading /> : !topItems.items.length ? <Empty small text="七日内暂无作品" /> : <View style={{ gap: 8 }}>
          {topItems.items.map((item) => <Pressable key={String(item.item_id)} accessibilityRole="button" onPress={() => onOpenWork(String(item.item_id))} style={styles.topRow}>
            {item.cover?.url_list?.[0] ? <Image source={{ uri: item.cover.url_list[0] }} style={styles.topCover} /> : <View style={[styles.topCover, { backgroundColor: color.surfaceMuted }]} />}
            <Text numberOfLines={1} style={[kit.body, { flex: 1 }]}>{item.title || "未命名作品"}</Text>
            <Text style={kit.muted}>{config.topLabel} <Text style={kit.strong}>{topItems.ratio ? `${(100 * Number(item.metric_value)).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%` : dcCount(item.metric_value)}</Text></Text>
          </Pressable>)}
        </View>}
      </View>
    </View>}
  </Panel>;
}

const PERIODS = [{ label: "昨天", value: 1 }, { label: "近7天", value: 7 }, { label: "近30天", value: 30 }];

/** 作品数据 / 粉丝数据共用：卡片 + 选中卡的每日趋势。 */
function DashboardBody({ tab, payload, selected, onSelect, perClient }: { tab: "aweme" | "mix" | "fans"; payload: Raw | null; selected: string; onSelect: (key: string) => void; perClient: boolean }) {
  const metrics = dashboardMetrics(tab, payload);
  const card = DASHBOARD_CARDS[tab].find((item) => item.key === selected) ?? DASHBOARD_CARDS[tab][0]!;
  const trends: Raw[] = metrics.get(card.key)?.trends ?? [];
  const scale = card.unit === "%" ? 100 : 1;
  const values = trends.map((trend) => Number(trend.value) * scale);
  const empty = !trends.length || values.reduce((sum, value) => sum + (value || 0), 0) === 0;
  // 抖音精选单列的几项（官方 isShowYumme）
  const yumme = tab === "aweme" && ["vv", "like", "net_follow_fans", "cover_click_ratio", "share"].includes(card.key);
  return <>
    <View style={kit.grid}>{DASHBOARD_CARDS[tab].map((item) => <MetricTile key={item.key} label={item.label} tip={item.tip} value={dashboardCardValue(item, metrics.get(item.key))} selected={item.key === card.key} onPress={() => onSelect(item.key)} />)}</View>
    {empty ? <Empty /> : <LineChart height={260} labels={trends.map((trend) => shortDate(String(trend.date_time)))} series={[{ label: card.label, values }]}
      format={(value) => dcValue(Number(value.toFixed(2)), card.unit === "" ? "" : card.unit)}
      details={(index) => {
        const trend = trends[index] ?? {};
        const lines: string[] = [];
        if (trend.change_rate !== undefined && trend.change_rate !== null) {
          const rate = Number(trend.change_rate);
          lines.push(`环比 ${rate > 0 ? "+" : rate < 0 ? "-" : ""}${(100 * Math.abs(rate)).toFixed(0)}%`);
        }
        if (perClient || yumme) {
          const douyin = yumme && !perClient ? Number(trend.value) - Number(trend.yumme_value ?? 0) : trend.douyin_value;
          if (douyin !== undefined) lines.push(`抖音 ${dcValue(Number(douyin) * scale, card.unit)}`);
        }
        if (perClient && trend.xigua_value !== undefined) lines.push(`西瓜 ${dcValue(Number(trend.xigua_value) * scale, card.unit)}`);
        if (yumme && trend.yumme_value !== undefined) lines.push(`抖音精选 ${dcValue(Number(trend.yumme_value) * scale, card.unit)}`);
        return lines;
      }} />}
  </>;
}

function WorkData({ connection }: { connection: ExploreConnection }) {
  const [tab, setTab] = useState<"aweme" | "mix" | "webcast">("aweme");
  const [days, setDays] = useState(7);
  const [selected, setSelected] = useState<Record<string, string>>({ aweme: DASHBOARD_DEFAULT.aweme, mix: DASHBOARD_DEFAULT.mix });
  const mixes = useCreator(connection, [{ key: "mix_list", params: { count: 1 } }, { key: "author_upgrade" }]);
  const hasMix = Boolean(mixes.data?.[0]?.mixs?.length);
  const perClient = Boolean(mixes.data?.[1]?.is_show_per_client_data);
  const query: CreatorQuery[] | null = tab === "aweme" ? [{ key: "dashboard", params: { recent_days: days } }] : tab === "mix" ? [{ key: "dashboard_mix", params: { recent_days: days } }] : null;
  const board = useCreator(connection, query);
  const tabs = [{ label: "投稿", value: "aweme" as const }, ...(hasMix ? [{ label: "合集", value: "mix" as const }] : []), { label: "直播", value: "webcast" as const }];
  return <Panel title="作品数据" subtitle={`统计周期：${periodText(days)}（每日10点更新前一日数据）`} extra={<Segmented options={PERIODS} value={days} onChange={setDays} />}>
    <Tabs options={tabs} value={tab} onChange={setTab} />
    {tab === "webcast" ? <LiveData connection={connection} days={days} />
      : board.error ? <ErrorLine text={board.error} onRetry={board.reload} />
        : board.loading ? <Loading />
          : <DashboardBody tab={tab} payload={board.data?.[0] ?? null} selected={selected[tab] ?? DASHBOARD_DEFAULT[tab]} onSelect={(key) => setSelected((current) => ({ ...current, [tab]: key }))} perClient={perClient} />}
  </Panel>;
}

function LiveData({ connection, days }: { connection: ExploreConnection; days: number }) {
  const [tabType, setTabType] = useState(1);
  const [picked, setPicked] = useState<string | null>(null);
  const config = LIVE_TABS.find((item) => item.id === tabType)!;
  const billboard = tabType === 1 ? "live_gift_billboard" : tabType === 2 ? "live_watch_billboard" : tabType === 4 ? "live_fans_source" : null;
  const board = useCreator(connection, [{ key: "live_dashboard", params: { day_window: days, tab_type: tabType } }, ...(billboard ? [{ key: billboard, params: { day_window: days } } as CreatorQuery] : [])]);
  const cards: Raw = board.data?.[0]?.data ?? {};
  const present = config.metrics.filter((metric) => cards[metric.key]);
  const current = present.find((metric) => metric.key === picked) ?? present[0] ?? null;
  const trend = useCreator(connection, current && days !== 1 ? [{ key: "live_trends", params: { day_window: days, metrics_type: current.type } }] : null);
  useEffect(() => { setPicked(null); }, [tabType]);
  const scale = (unit: string) => (unit === "%" ? 100 : 1);
  const points: Raw[] = current ? (days === 1 ? [{ date: cards[current.key]?.date, value: cards[current.key]?.value }] : (trend.data?.[0]?.data ?? [])) : [];
  const extra = board.data?.[1]?.data ?? null;
  return <View style={{ gap: 14 }}>
    <Segmented small options={LIVE_TABS.map((item) => ({ label: item.label, value: item.id }))} value={tabType} onChange={setTabType} />
    {board.error ? <ErrorLine text={board.error} onRetry={board.reload} /> : board.loading ? <Loading /> : <>
      <View style={kit.grid}>
        {present.map((metric) => <MetricTile key={metric.key} label={cards[metric.key]?.name ?? metric.key} value={dcValue(Number(cards[metric.key]?.value ?? 0) * scale(metric.unit), metric.unit)} selected={current?.key === metric.key} onPress={() => setPicked(metric.key)} />)}
        {Array.from({ length: Math.max(0, 4 - present.length) }, (_, index) => <View key={`pad${index}`} style={styles.tilePad} />)}
      </View>
      {current ? <View style={{ gap: 8 }}>
        <Text style={kit.subhead}>{days < 7 ? "今日数据" : `近${days}天趋势`}</Text>
        {days !== 1 && trend.loading ? <Loading /> : points.length ? <LineChart height={220} labels={points.map((point) => String(point.date ?? "").slice(5))} series={[{ label: cards[current.key]?.name ?? "", values: points.map((point) => Number(point.value ?? 0) * scale(current.unit)) }]} format={(value) => dcValue(value, current.unit)} /> : <Empty />}
      </View> : null}
      {tabType === 1 || tabType === 2 ? <View style={{ gap: 8 }}>
        <Text style={kit.subhead}>{tabType === 1 ? "点赞送礼TOP20" : "观看时长TOP20"}</Text>
        {(() => {
          const list: Raw[] = (tabType === 1 ? extra?.gift_billboard : extra?.watch_billboard) ?? [];
          return list.length ? <View style={styles.billboard}>{list.map((row) => <View key={`${row.rank}${row.encrypted_user_id}`} style={styles.billboardRow}>
            <Text style={[styles.rankBadge, Number(row.rank) <= 3 && { color: color.accent }]}>{row.rank}</Text>
            {row.avatar_url ? <Image source={{ uri: row.avatar_url }} style={styles.smallAvatar} /> : null}
            <Text numberOfLines={1} style={[kit.body, { flex: 1 }]}>{row.nick_name}</Text>
            {row.fan_group_level ? <Text style={kit.muted}>粉丝团 {row.fan_group_level}</Text> : null}
          </View>)}</View> : <Empty small />;
        })()}
      </View> : null}
      {tabType === 4 ? <View style={{ gap: 8 }}>
        <Text style={kit.subhead}>新增粉丝来源分析</Text>
        {(() => {
          const list: Raw[] = extra?.NewFansSource ?? [];
          return list.some((item) => Number(item.value) > 0) ? <View style={{ gap: 10 }}>
            <Donut slices={list.map((item) => ({ label: String(item.name), value: Number(item.value) || 0 }))} />
            {list.map((item) => <Text key={item.name} style={kit.muted}>{item.name} {item.value} {(100 * Number(item.rate || 0)).toFixed(2)}% <Text style={{ color: Number(item.compare) === 1 ? color.danger : color.green }}>{Number(item.compare) === 1 ? "↑" : "↓"}</Text></Text>)}
          </View> : <Empty small />;
        })()}
      </View> : null}
    </>}
  </View>;
}

function FansData({ connection }: { connection: ExploreConnection }) {
  const [days, setDays] = useState(7);
  const [selected, setSelected] = useState<string>(DASHBOARD_DEFAULT.fans);
  const board = useCreator(connection, [{ key: "dashboard_fans", params: { recent_days: days } }]);
  return <Panel title="粉丝数据" subtitle={`统计周期：${periodText(days)}（每日10点更新前一日数据）`} extra={<Segmented options={PERIODS} value={days} onChange={setDays} />}>
    {board.error ? <ErrorLine text={board.error} onRetry={board.reload} /> : board.loading ? <Loading />
      : <DashboardBody tab="fans" payload={board.data?.[0] ?? null} selected={selected} onSelect={setSelected} perClient={false} />}
  </Panel>;
}

function FansPortrait({ connection, followers }: { connection: ExploreConnection; followers: number }) {
  const open = followers >= 300;
  const summary = useCreator(connection, open ? [{ key: "fans_summary" }] : null);
  const data: Raw | null = summary.data?.[0] ?? null;
  const percent = (value: number) => `${value.toFixed(1)}%`;
  const list = (rows: Array<{ name: string; value: number }>, ranked = false) => rows.length
    ? <BarList rows={rows.slice(0, 6).map((row, index) => ({ label: ranked ? `${index + 1}  ${row.name}` : row.name, ratio: row.value, value: percent(row.value) }))} />
    : <Empty small />;
  const block = (title: string, body: React.ReactNode) => <View style={styles.portraitBlock}><Text style={kit.subhead}>{title}</Text>{body}</View>;
  let body: React.ReactNode;
  if (!open) body = <Empty lines={["粉丝数达到300可查看粉丝画像，积极创作吸引更多粉丝吧", "粉丝数首次达到300，数据次日计算产出"]} />;
  else if (summary.error) body = <Empty text={summary.error || "粉丝画像加载失败，请稍后重试"} />;
  else if (!data) body = <Loading />;
  else {
    const gender = fansDistribution(data.gender_distribution, "normalize", GENDER_NAMES).sort((a, b) => ["男性", "女性"].indexOf(a.name) - ["男性", "女性"].indexOf(b.name));
    const activeOrder = ["重度", "中度", "轻度", "静默", "低活", "未知"];
    const active = fansDistribution(data.active_levels).sort((a, b) => (activeOrder.indexOf(a.name) + 99) % 99 - (activeOrder.indexOf(b.name) + 99) % 99);
    const age = fansDistribution(data.age_distribution, "age");
    const device = fansDistribution(data.device_brand_distribution).sort((a, b) => b.value - a.value);
    const city = fansDistribution(data.city_distribution, "raw");
    const interest = fansDistribution(data.fans_interest_distribution, "raw");
    const keywords: Raw[] = Array.isArray(data.fans_portrait?.like_item_keyword) ? data.fans_portrait.like_item_keyword : [];
    const anything = [gender, active, age, device, city, interest].some((rows) => rows.some((row) => row.value > 0));
    body = !anything ? <Empty text="暂无粉丝画像数据" /> : <View style={styles.portraitGrid}>
      {block("性别分布", gender.some((row) => row.value > 0) ? <Donut slices={gender.map((row) => ({ label: row.name, value: row.value }))} /> : <Empty small />)}
      {block("活跃度分布", active.some((row) => row.value > 0) ? <Donut slices={active.map((row) => ({ label: row.name, value: row.value }))} /> : <Empty small />)}
      {block("年龄分布", list(age))}
      {block("设备分布", list(device, true))}
      {block("地域分布", list(city, true))}
      {block("粉丝兴趣", list(interest, true))}
      {block("粉丝关注", followers < 1000 ? <Empty small text="粉丝量未达到1000，暂无热词分析" /> : keywords.length
        ? <View style={{ gap: 6 }}>{keywords.slice(0, 6).map((row, index) => <View key={`${row.name}${index}`} style={kit.between}><Text style={kit.body}>{index + 1}  {row.name}</Text><Text style={kit.muted}>热度{row.value}</Text></View>)}</View>
        : <Empty small text="暂无热词分析数据" />)}
    </View>;
  }
  return <Panel title="粉丝画像">{body}</Panel>;
}

// ---------------- 作品管理 ----------------

interface WorkCard {
  id: string; cover: string | null; badge: string | null; desc: string; time: number; status: { key: string; label: string };
  metrics: Raw | undefined; set: ReturnType<typeof listMetricSet>; hidden: boolean; isPrivate: boolean; pinned: boolean; type: number;
}

function workCards(payload: Raw): WorkCard[] {
  const items: Raw[] = payload.items ?? [];
  return ((payload.aweme_list ?? []) as Raw[]).map((aweme, index) => {
    const id = String(aweme.aweme_id);
    const item = items.find((entry) => String(entry.id) === id) ?? items[index];
    const merged = { ...aweme, metrics: item?.metrics, type: item?.type };
    const images = Array.isArray(aweme.images) ? aweme.images.length : 0;
    const cover = aweme.video?.optimized_cover?.url_list?.[0] ?? aweme.video?.cover?.url_list?.[0] ?? null;
    const publishAt = aweme.timer && [0, 4, 5].includes(Number(aweme.timer.status)) && aweme.timer.public_time ? Number(aweme.timer.public_time) : Number(aweme.create_time);
    return {
      id, cover, desc: aweme.desc || "", time: publishAt, status: workStatus(aweme), metrics: item?.metrics, set: listMetricSet(merged),
      hidden: listMetricsHidden(aweme, item?.metrics), isPrivate: Number(aweme.status?.private_status) === 1, pinned: Boolean(aweme.is_pinned), type: Number(item?.type ?? 0),
      badge: images ? `${images}张` : aweme.is_slides ? null : listDuration(Number(aweme.video?.duration ?? aweme.duration ?? 0)),
    };
  });
}

// 按播放/点赞排序走另一条接口，返回的是作品详情那种结构
function sortedCards(payload: Raw): WorkCard[] {
  return ((payload.items ?? []) as Raw[]).map((item) => {
    const type = Number(item.type);
    const pictures = Number(item.picture_info?.count ?? 0);
    return {
      id: String(item.id), cover: item.cover?.url_list?.[0] ?? null, desc: item.description || "", time: Number(item.create_time),
      status: Number(item.review?.status) === 2 ? { key: "PUBLISHED", label: "已发布" } : { key: "", label: "" },
      metrics: item.metrics, set: listMetricSet({ type, is_pic_word: [1, 6, 7].includes(type), duration: Number(item.video_info?.duration ?? 0) }),
      hidden: !item.metrics, isPrivate: false, pinned: false, type,
      badge: pictures ? `${pictures}张` : type === 8 ? null : listDuration(Number(item.video_info?.duration ?? 0)),
    };
  });
}

function WorkList({ connection, onOpenWork }: { connection: ExploreConnection; onOpenWork: (id: string) => void }) {
  const [status, setStatus] = useState(0);
  const [types, setTypes] = useState<number[]>([]);
  const [sort, setSort] = useState<"time" | "play" | "like">("time");
  const [keyword, setKeyword] = useState("");
  const [cards, setCards] = useState<WorkCard[]>([]);
  const [cursor, setCursor] = useState<Raw>({ max: 0 });
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const run = useRef(0);
  const filterOn = types.length > 0 && types.length < WORK_TYPE_FILTER.length;

  async function load(reset: boolean) {
    const current = reset ? ++run.current : run.current;
    setLoading(true); setError(null);
    try {
      let collected: WorkCard[] = [];
      let next: Raw = reset ? { max: 0 } : cursor;
      let more = true;
      if (sort !== "time") {
        let uid = userId;
        if (!uid) {
          const [first] = await readCreator(connection, [{ key: "work_list", params: { status: 0, count: 1, max_cursor: 0 } }]);
          uid = String(first?.items?.[0]?.user_id ?? first?.aweme_list?.[0]?.author?.uid ?? "");
          setUserId(uid);
        }
        const end = Date.now();
        const [payload] = await readCreator(connection, [{ key: "item_list", params: {
          user_id: uid, count: 12, order_by: sort === "play" ? 3 : 5, start_time: String(end - 90 * 86400000), end_time: String(end),
          ...(reset ? {} : { min_cursor: String(next.min ?? ""), max_cursor: String(next.max ?? "") }),
        } }]);
        if (!payload || (payload.status_code ?? 0) !== 0) {
          const code = Number(payload?.status_code);
          throw new Error(code === 7 ? "当前账号暂无数据中心权限，请使用最新发布排序" : code === 200001 ? "该时间范围内作品超过 1000 条，请缩小发布时间范围后再排序" : "作品排序加载失败，请重试");
        }
        collected = sortedCards(payload);
        next = { min: payload.min_cursor, max: payload.max_cursor };
        more = Boolean(payload.has_more);
      } else {
        // 体裁是前端再过滤：选了体裁时一次多拿几页，最多看最近 100 条（和官方一样）
        for (let attempt = 0; attempt < (filterOn ? 10 : 5); attempt += 1) {
          const [payload] = await readCreator(connection, [{ key: "work_list", params: { status, count: filterOn ? Math.min(40, 100 - collected.length) : 12, max_cursor: next.max ?? 0 } }]);
          if (!payload || (payload.status_code ?? 0) !== 0) throw new Error(payload?.status_msg || "作品加载失败，请重试");
          if (reset && attempt === 0 && status === 0 && !filterOn && total === null) setTotal(Number(payload.total) || 0);
          const page = workCards(payload).filter((card) => !filterOn || types.includes(card.type));
          collected = collected.concat(page);
          more = Boolean(payload.has_more) && String(payload.max_cursor) !== String(next.max);
          next = { max: payload.max_cursor };
          if (!more || (!filterOn && collected.length >= 12) || (filterOn && collected.length >= 100)) break;
        }
        if (filterOn) more = false;
      }
      if (current !== run.current) return;
      setCards((existing) => (reset ? collected : existing.concat(collected)));
      setCursor(next); setHasMore(more);
    } catch (cause) {
      if (current === run.current) setError(cause instanceof Error ? cause.message : "作品加载失败，请重试");
    } finally {
      if (current === run.current) setLoading(false);
    }
  }
  useEffect(() => { void load(true); }, [status, sort, types.join(",")]);
  useEffect(() => {
    if (total !== null) return;
    void readCreator(connection, [{ key: "work_list", params: { status: 0, count: 1, max_cursor: 0 } }]).then(([payload]) => setTotal(Number(payload?.total) || 0), () => {});
  }, []);

  const shown = keyword.trim() ? cards.filter((card) => card.desc.includes(keyword.trim())) : cards;
  const toggleType = (value: number) => {
    setTypes((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
    setSort("time");
  };
  return <Panel title={total ? `作品 (${total})` : "作品"}>
    <View style={{ gap: 10 }}>
      <View style={kit.row}><Text style={kit.muted}>审核状态</Text><Segmented small options={WORK_STATUS_FILTER} value={status} onChange={(value) => { setStatus(value); if (value) setSort("time"); }} /></View>
      <View style={kit.row}><Text style={kit.muted}>体裁</Text>
        {WORK_TYPE_FILTER.map((item) => <Pressable key={item.value} accessibilityRole="checkbox" accessibilityState={{ checked: types.includes(item.value) }} onPress={() => toggleType(item.value)} style={[styles.chip, types.includes(item.value) && styles.chipOn]}>
          <Text style={[kit.muted, types.includes(item.value) && { color: color.text }]}>{item.label}</Text></Pressable>)}
        {types.length ? <Pressable accessibilityRole="button" onPress={() => setTypes([])}><Text style={kit.muted}>清空</Text></Pressable> : null}
      </View>
      <View style={kit.between}>
        <View style={kit.row}><Text style={kit.muted}>排序</Text><Segmented small options={[{ label: "最新发布", value: "time" as const }, { label: "最高播放", value: "play" as const }, { label: "最高点赞", value: "like" as const }]} value={sort}
          onChange={(value) => { setSort(value); if (value !== "time") { setStatus(0); setTypes([]); } }} /></View>
        <View style={styles.search}><Search size={14} color={color.textMuted} /><TextInput accessibilityLabel="搜索作品" value={keyword} onChangeText={setKeyword} placeholder="搜索作品" placeholderTextColor={color.textMuted} style={styles.searchInput} /></View>
      </View>
    </View>
    {notice ? <Text accessibilityLiveRegion="polite" style={[kit.muted, { color: color.amber }]}>{notice}</Text> : null}
    {error ? <ErrorLine text={error} onRetry={() => void load(cards.length === 0)} /> : null}
    <View style={{ gap: 10 }}>
      {shown.map((card) => <WorkRow key={card.id} card={card} onPress={() => {
        if (card.hidden) { setNotice("当前作品状态，暂不支持查看详情数据"); return; }
        setNotice(null); onOpenWork(card.id);
      }} />)}
    </View>
    {keyword.trim() && !shown.length && !loading ? <Empty text={`没有“${keyword.trim()}”相关作品`} /> : null}
    {loading ? <Loading label="加载中…" /> : hasMore ? <View style={{ alignItems: "center" }}><SmallButton label="加载更多" onPress={() => void load(false)} /></View>
      : <Text style={[kit.muted, { textAlign: "center" }]}>{sort === "time" ? "没有更多作品" : "点赞、播放排序仅支持近90天内作品"}</Text>}
  </Panel>;
}

function WorkRow({ card, onPress }: { card: WorkCard; onPress: () => void }) {
  const tone = STATUS_TONE[card.status.key];
  const toneColor = tone === "good" ? color.green : tone === "warn" ? color.amber : tone === "info" ? color.cyan : tone === "dark" ? color.text : color.textMuted;
  return <Pressable accessibilityRole="button" accessibilityLabel={`查看作品数据：${card.desc || "无作品描述"}`} onPress={onPress} {...ws("e-box")} style={styles.work}>
    <View style={styles.workCover}>
      {card.cover ? <Image source={{ uri: card.cover }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
      {card.pinned ? <Text {...ws("cr-badge")} style={[styles.coverTag, { top: 6, left: 6 }]}>置顶</Text> : null}
      {card.isPrivate ? <View style={[styles.coverTag, styles.coverPrivate]}><Lock size={10} color="#fff" /><Text {...ws("cr-badge")} style={styles.coverTagText}> 私密</Text></View> : null}
      {card.badge ? <Text {...ws("cr-badge")} style={[styles.coverTag, { right: 6, bottom: 6 }]}>{card.badge}</Text> : null}
    </View>
    <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
      <Text numberOfLines={2} style={[kit.body, { color: card.desc ? color.text : color.textMuted }]}>{card.desc || "无作品描述"}</Text>
      <View style={kit.row}><Text style={kit.muted}>{card.time ? fullTime(card.time) : ""}</Text>{card.status.label ? <Text style={[kit.muted, { color: toneColor }]}>{card.status.label}</Text> : null}</View>
      <View style={styles.workMetrics}>{card.set.map((metric) => <View key={metric.key} style={styles.workMetric}>
        <Text style={kit.muted}>{metric.label}</Text>
        <Text style={styles.workMetricValue}>{card.hidden ? "-" : metric.kind === "rate" ? listRate(card.metrics?.[metric.key]) : listCount(card.metrics?.[metric.key])}</Text>
      </View>)}</View>
    </View>
  </Pressable>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
  content: { padding: 32, gap: 18, paddingBottom: 70 },
  contentNarrow: { padding: 16 },
  eyebrow: { color: color.cyan, fontFamily: font.body, fontSize: 10, letterSpacing: 2 },
  title: { color: color.text, fontFamily: font.body, fontSize: 28, fontWeight: "600" },
  gate: { alignItems: "center", gap: 14, paddingVertical: 60 },
  gateTitle: { color: color.text, fontFamily: font.body, fontSize: 17, fontWeight: "600" },
  profile: { flexDirection: "row", alignItems: "center", gap: 18, padding: 20, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface, flexWrap: "wrap" },
  avatar: { width: 64, height: 64, borderRadius: 32 },
  avatarEmpty: { alignItems: "center", justifyContent: "center", backgroundColor: color.surfaceMuted },
  name: { color: color.text, fontFamily: font.body, fontSize: 18, fontWeight: "600" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  sentence: { padding: 12, borderRadius: radius.small, backgroundColor: color.surfaceRaised },
  topRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 10, borderRadius: radius.small, backgroundColor: color.surfaceRaised },
  topCover: { width: 38, height: 50, borderRadius: 4 },
  tilePad: { flexGrow: 1, flexBasis: 120, minWidth: 112 },
  billboard: { gap: 6 },
  billboardRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  rankBadge: { width: 22, textAlign: "center", color: color.textMuted, fontFamily: font.body, fontSize: 12, fontWeight: "700" },
  smallAvatar: { width: 26, height: 26, borderRadius: 13 },
  portraitGrid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  portraitBlock: { flexGrow: 1, flexBasis: 300, gap: 12, padding: 14, borderRadius: radius.small, backgroundColor: color.surfaceRaised },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, borderWidth: 1, borderColor: color.borderSoft },
  chipOn: { borderColor: color.accent, backgroundColor: alpha(color.accent, 0.1) },
  search: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small, minWidth: 200 },
  searchInput: { flex: 1, minHeight: 32, color: color.text, fontFamily: font.body, fontSize: 12 },
  work: { flexDirection: "row", gap: 14, padding: 12, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small, backgroundColor: color.surfaceRaised },
  workCover: { width: 96, height: 128, borderRadius: 6, overflow: "hidden", backgroundColor: color.surfaceMuted },
  coverTag: { position: "absolute", paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4, backgroundColor: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 10, fontFamily: font.body },
  coverPrivate: { left: 6, bottom: 6, flexDirection: "row", alignItems: "center" },
  coverTagText: { color: "#fff", fontSize: 10, fontFamily: font.body },
  workMetrics: { flexDirection: "row", flexWrap: "wrap", gap: 18 },
  workMetric: { gap: 2, minWidth: 48 },
  workMetricValue: { color: color.text, fontFamily: font.body, fontSize: 14, fontWeight: "600" },
});
