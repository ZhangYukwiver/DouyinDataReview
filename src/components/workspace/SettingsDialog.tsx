import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Check, Download, RefreshCw, Trash2, UserRoundPlus, X, type LucideIcon } from "lucide-react-native";

import { getDesktopOpenAtLogin, setDesktopOpenAtLogin, type DesktopUpdateState } from "../../desktopRuntime";
import { APP_STYLES, STORY_STYLES, type AppStyle, type StoryStyle } from "../../services/appStyle";
import { collectorAccountName, findTwinAccount, formatAccountAddedDay, type CollectorAccounts } from "../../services/localCollector";
import { ease, ws } from "./motion";
import { appUpdateAction } from "./setupModel";
import { alpha, palettes, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

export type SettingsSection = "appearance" | "reading" | "privacy" | "account" | "data" | "about";

export interface SettingsDialogProps {
  visible: boolean;
  onClose: () => void;
  /** 打开时先滚到哪一节（例如采集器页的账号按钮打开时直接到账号） */
  section?: SettingsSection;
  appStyle: AppStyle;
  onChangeAppStyle: (style: AppStyle) => void;
  /** 极简风格打开报告时借用的那套故事页 */
  storyStyle: StoryStyle;
  onChangeStoryStyle: (style: StoryStyle) => void;
  autoSyncEnabled: boolean;
  onToggleAutoSync: () => void;
  privacy: boolean;
  onTogglePrivacy: () => void;
  connected: boolean;
  accounts: CollectorAccounts | null;
  /** 当前账号的显示名（采集器状态里的昵称优先） */
  activeAccountName: string | null;
  /** 现在不能换号的原因；null 表示可以换 */
  accountBlocked: string | null;
  /** 正在换号：删除也先禁用（和手绘账号面板一样；App 换号期间会直接忽略删除） */
  switchingAccount?: boolean;
  onActivateAccount: (id: string) => void;
  onAddAccount: () => void;
  onRemoveAccount: (id: string, name: string) => void;
  onExportData: () => void;
  /** 有本地记录且采集器不忙时才能清除 */
  canClear: boolean;
  onClearCache: () => void;
  appUpdate: DesktopUpdateState | null;
  /** 采集器正在读取或手动监听：下好的更新先不装，按钮写「采集完成后安装」（和采集器页的更新面板一样） */
  installBlocked?: boolean;
  onCheckAppUpdate: () => Promise<void>;
  onDownloadAppUpdate: () => Promise<void>;
  onInstallAppUpdate: () => Promise<void>;
}

const web = Platform.OS === "web";
const pointer = web ? ({ cursor: "pointer" } as object) : null;
const SECTIONS: ReadonlyArray<{ key: SettingsSection; title: string }> = [
  { key: "appearance", title: "外观" },
  { key: "reading", title: "读取" },
  { key: "privacy", title: "隐私" },
  { key: "account", title: "账号" },
  { key: "data", title: "数据" },
  { key: "about", title: "关于" },
];

/** 账号名下面那行小字：哪天添加的；同一个抖音号添加了两次时提醒一下，删的时候分得清 */
export function accountNote(accounts: CollectorAccounts["accounts"], index: number): string {
  const account = accounts[index];
  if (!account) return "";
  const added = formatAccountAddedDay(account.createdAt);
  return [added ? `${added}添加` : null, findTwinAccount(accounts, account) ? "和另一个是同一个抖音号" : null].filter(Boolean).join("，");
}

/** 设置面板：App 级模态，采集器页与工作台共用，颜色字体圆角全跟整体风格的 token 走。 */
export function SettingsDialog(props: SettingsDialogProps) {
  const { visible, onClose, section } = props;
  const { width, height } = useWindowDimensions();
  const dialogWidth = Math.min(640, Math.round(width * 0.92));
  // 左右内边距 24×2，再减去左右框线（海报 3，其余 1）；只是第一帧的估算，风格卡那一行会按量到的宽度重排
  const contentWidth = dialogWidth - 48 - (props.appStyle === "poster" ? 6 : 2);
  const scrollRef = useRef<ScrollView>(null);
  const closeRef = useRef<View>(null);
  // 各节在滚动内容里的位置；打开时要先到的那一节量到了就滚过去
  const offsets = useRef<Partial<Record<SettingsSection, number>>>({});
  const pending = useRef<SettingsSection | null>(null);
  // 「开机后在后台运行」：null = 不是桌面版、旧版外壳或系统不支持，这一行不显示。
  // 挂载时就先问一次，打开面板时这一行已经在了，不会在滚到某一节之后才插进来把位置顶歪
  const [openAtLogin, setOpenAtLogin] = useState<boolean | null>(null);

  const scrollToPending = () => {
    const target = pending.current;
    const y = target ? offsets.current[target] : undefined;
    if (!target || y === undefined) return;
    scrollRef.current?.scrollTo({ y: target === "appearance" ? 0 : y, animated: false });
  };

  // 关上以后 Modal 还要淡出一会儿才卸掉内容，这期间再打开时各节不会重新量，所以记下的位置不清空，先按它滚；
  // 刚打开的这一小会儿各节可能还在量（或者位置变了），量到要去的那一节就再对一次，过了这一会儿就不再替用户滚
  useEffect(() => {
    if (!visible) return undefined;
    pending.current = section ?? "appearance";
    scrollToPending();
    const timer = setTimeout(() => { pending.current = null; }, 600);
    return () => clearTimeout(timer);
  }, [section, visible]);

  useEffect(() => {
    let live = true;
    void getDesktopOpenAtLogin().then((value) => { if (live) setOpenAtLogin(value); });
    return () => { live = false; };
  }, [visible]);

  // 打开时把焦点放到关闭钮上，别留在被遮住的按钮上；Esc 由 Modal 的 onRequestClose 接
  useEffect(() => {
    if (!visible || !web) return undefined;
    const frame = requestAnimationFrame(() => (closeRef.current as unknown as HTMLElement | null)?.focus?.());
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  const measure = (key: SettingsSection) => (event: LayoutChangeEvent) => {
    offsets.current[key] = event.nativeEvent.layout.y;
    if (pending.current === key) scrollToPending();
  };

  const toggleOpenAtLogin = () => {
    if (openAtLogin === null) return;
    const next = !openAtLogin;
    setOpenAtLogin(next);
    void setDesktopOpenAtLogin(next).then((actual) => setOpenAtLogin(actual ?? !next));
  };

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.backdrop}>
        {/* 遮罩用响应者而不是 Pressable：RN-web 的 Pressable 总带 tabIndex=0，会变成一个看不见、按回车就关面板的 Tab 停留点 */}
        <View onResponderRelease={onClose} onStartShouldSetResponder={() => true} style={[StyleSheet.absoluteFill, pointer]} testID="settings-backdrop" />
        <View
          {...role(props.appStyle, "w-dialog")}
          accessibilityLabel="设置"
          accessibilityViewIsModal
          style={[styles.dialog, props.appStyle === "poster" && styles.dialogPoster, { width: dialogWidth, maxHeight: Math.round(height * 0.86) }]}
          testID="settings-dialog"
        >
          <View style={styles.head}>
            <Text accessibilityRole="header" style={styles.title}>设置</Text>
            <Pressable
              accessibilityLabel="关闭设置"
              accessibilityRole="button"
              onPress={onClose}
              ref={closeRef}
              style={(state) => [styles.close, hovered(state) && styles.closeHover, pointer, ease("background-color", 140)]}
              testID="settings-close"
            >
              <View style={styles.icon18}><X color={color.textSecondary} size={18} strokeWidth={1.9} /></View>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.body} ref={scrollRef} style={styles.scroll}>
            {SECTIONS.map(({ key, title }) => (
              <View key={key} onLayout={measure(key)} style={styles.section} testID={`settings-section-${key}`}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>
                {key === "appearance" ? <Appearance {...props} contentWidth={contentWidth} />
                  : key === "reading" ? <Reading {...props} openAtLogin={openAtLogin} onToggleOpenAtLogin={toggleOpenAtLogin} />
                    : key === "privacy" ? <Privacy {...props} />
                      : key === "account" ? <Account {...props} />
                        : key === "data" ? <Data {...props} />
                          : <About {...props} />}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ---------- 各节 ----------

function Appearance({ appStyle, contentWidth, onChangeAppStyle, onChangeStoryStyle, storyStyle }: SettingsDialogProps & { contentWidth: number }) {
  // 四项一行；面板窄到放不下时排成两行两列。宽度按量到的为准（海报的框线粗，估算会多出几像素把第四张挤下去）
  const [gridWidth, setGridWidth] = useState<number | null>(null);
  const width = gridWidth ?? contentWidth;
  const columns = width >= 480 ? 4 : 2;
  const cardWidth = Math.floor((width - GRID_GAP * (columns - 1)) / columns);
  return (
    <>
      <View style={[styles.row, styles.rowStacked]}>
        <RowCopy detail="工作台和打开的报告都会换成这一套。" title="界面风格" />
        <View accessibilityLabel="界面风格" accessibilityRole="radiogroup" onLayout={(event) => setGridWidth(event.nativeEvent.layout.width)} style={styles.styleGrid} testID="app-style">
          {APP_STYLES.map((item) => {
            const on = item.key === appStyle;
            return (
              <Pressable
                accessibilityLabel={`${item.label}：${item.detail}`}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                aria-checked={on}
                key={item.key}
                onPress={() => { if (!on) onChangeAppStyle(item.key); }}
                {...spaceKey(() => { if (!on) onChangeAppStyle(item.key); })}
                style={(state) => [styles.styleCard, { width: cardWidth }, on ? styles.styleCardOn : hovered(state) && styles.styleCardHover, pointer, ease("border-color", 140)]}
                testID={`app-style-${item.key}`}
              >
                <StyleSwatch kind={item.key} />
                <View style={styles.styleNameRow}>
                  <Text numberOfLines={1} style={[styles.styleName, on && styles.styleNameOn]}>{item.label}</Text>
                  {on ? <View style={styles.icon14}><Check color={color.accent} size={14} strokeWidth={2.2} /></View> : null}
                </View>
                {/* 说明是「材质 · 特点」两段，一段一行，别在卡片里折出一个孤字 */}
                <View>
                  {item.detail.split(" · ").map((part) => <Text key={part} numberOfLines={1} style={styles.styleDetail}>{part}</Text>)}
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>
      {appStyle === "minimal" ? (
        <View style={styles.row}>
          <RowCopy detail="极简没有单独的报告页，打开报告时用这一套。" title="打开报告用" />
          <View accessibilityLabel="打开报告用" accessibilityRole="radiogroup" style={styles.segment} testID="story-style">
            {STORY_STYLES.map((item) => {
              const on = item.key === storyStyle;
              return (
                <Pressable
                  accessibilityLabel={`${item.label}：${item.detail}`}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  aria-checked={on}
                  key={item.key}
                  onPress={() => { if (!on) onChangeStoryStyle(item.key); }}
                  {...spaceKey(() => { if (!on) onChangeStoryStyle(item.key); })}
                  style={(state) => [styles.segmentItem, on ? styles.segmentItemOn : hovered(state) && styles.segmentItemHover, pointer, ease("background-color", 140)]}
                  testID={`story-style-${item.key}`}
                >
                  <Text numberOfLines={1} style={[styles.segmentText, on && styles.segmentTextOn]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </>
  );
}

function Reading({ autoSyncEnabled, onToggleAutoSync, onToggleOpenAtLogin, openAtLogin }: SettingsDialogProps & { openAtLogin: boolean | null; onToggleOpenAtLogin: () => void }) {
  return (
    <>
      <View style={styles.row}>
        <RowCopy
          detail="开着时，回到窗口或刚连上采集器，都会自己把新的观看、喜欢和收藏补进来。关掉以后，只在你点读取时才读。"
          title="自动补读新记录"
        />
        <Toggle label="自动补读新记录" onPress={onToggleAutoSync} testID="settings-auto-sync" value={autoSyncEnabled} />
      </View>
      {openAtLogin !== null ? (
        <View style={styles.row}>
          <RowCopy
            detail="开机时悄悄启动，不弹窗口；开着自动补读的话，会隔几个小时补读一次。要看窗口，点菜单栏或托盘里的图标。"
            title="开机后在后台运行"
          />
          <Toggle label="开机后在后台运行" onPress={onToggleOpenAtLogin} testID="settings-open-at-login" value={openAtLogin} />
        </View>
      ) : null}
    </>
  );
}

function Privacy({ onTogglePrivacy, privacy }: SettingsDialogProps) {
  return (
    <View style={styles.row}>
      <RowCopy detail="隐藏封面、标题和聊天内容，视频和直播也先不放，适合截图或给别人看。" title="隐私模式" />
      <Toggle label="隐私模式" onPress={onTogglePrivacy} testID="settings-privacy" value={privacy} />
    </View>
  );
}

function Account({ accountBlocked, accounts, activeAccountName, appStyle, connected, onActivateAccount, onAddAccount, onClose, onRemoveAccount, switchingAccount = false }: SettingsDialogProps) {
  if (!connected) {
    return (
      <View style={styles.row}>
        <RowCopy detail="先在采集器页连上采集器，这里才能切换、添加或删除抖音账号。" title="抖音账号" />
      </View>
    );
  }
  const rows = accounts?.accounts ?? [];
  const blocked = Boolean(accountBlocked);
  return (
    <>
      <View style={[styles.row, styles.rowIntro]}>
        <Text style={styles.detail}>
          {activeAccountName ? `现在用的是「${activeAccountName}」。` : ""}每个账号的登录和记录分开存，切换不会删掉记录。
        </Text>
        {accountBlocked ? <Text accessibilityLiveRegion="polite" style={styles.warning} testID="settings-account-blocked">{accountBlocked}</Text> : null}
      </View>
      {rows.length ? rows.map((account, index) => {
        const current = account.id === accounts?.activeId;
        const name = current && activeAccountName ? activeAccountName : collectorAccountName(account, index);
        const note = accountNote(rows, index);
        const avatar = color.avatars[index % color.avatars.length]!;
        return (
          <View key={account.id} style={styles.row} testID={`settings-account-${account.id}`}>
            <View {...role(appStyle, "c-avatar")} style={[styles.avatar, { backgroundColor: alpha(avatar, 0.19) }]}>
              <Text style={[styles.avatarText, { color: avatar }]}>{account.nickname ? Array.from(account.nickname)[0] : String(index + 1)}</Text>
            </View>
            <View style={styles.copy}>
              <Text numberOfLines={1} style={styles.rowTitle}>{name}</Text>
              {note ? <Text numberOfLines={1} style={styles.detail}>{note}</Text> : null}
            </View>
            {current ? (
              <View style={styles.currentTag}><Text style={styles.currentText}>正在用</Text></View>
            ) : (
              <View style={styles.actions}>
                <Button appStyle={appStyle} accessibilityLabel={`切换到${name}`} disabled={blocked} label="切换" onPress={() => onActivateAccount(account.id)} />
                <Button appStyle={appStyle} accessibilityLabel={`删除${name}`} disabled={switchingAccount} kind="danger" label="删除" onPress={() => onRemoveAccount(account.id, name)} />
              </View>
            )}
          </View>
        );
      }) : (
        <View style={styles.row}><Text style={styles.detail}>还没读到账号列表，稍等一下再打开看看。</Text></View>
      )}
      <View style={styles.row}>
        <RowCopy detail="会打开专用浏览器，登录另一个抖音号以后自动开始读取。" title="添加账号" />
        <Button appStyle={appStyle} disabled={blocked} icon={UserRoundPlus} label="添加账号" onPress={() => { onClose(); onAddAccount(); }} testID="settings-account-add" />
      </View>
    </>
  );
}

function Data({ appStyle, canClear, connected, onClearCache, onExportData }: SettingsDialogProps) {
  return (
    <>
      {web ? (
        <View style={styles.row}>
          <RowCopy
            detail={connected
              ? "把读到的观看、喜欢、收藏和聊天记录存成一个文件，换电脑或重装以后可以在采集器页导入回来。"
              : "连上采集器以后，可以把读到的记录存成一个文件，换电脑或重装以后再导入回来。"}
            title="导出数据"
          />
          <Button appStyle={appStyle} disabled={!connected} icon={Download} label="导出数据" onPress={onExportData} testID="settings-export" />
        </View>
      ) : null}
      <View style={styles.row}>
        <RowCopy detail="只清掉这台电脑上存的观看、喜欢和收藏记录，抖音账号和登录都不受影响，下次读取会重新拿回来。" title="清除本地记录" />
        <Button appStyle={appStyle} disabled={!canClear} icon={Trash2} kind="danger" label="清除本地记录" onPress={onClearCache} testID="settings-clear" />
      </View>
    </>
  );
}

function About({ appStyle, appUpdate, installBlocked = false, onCheckAppUpdate, onDownloadAppUpdate, onInstallAppUpdate }: SettingsDialogProps) {
  if (!appUpdate) {
    return (
      <View style={styles.row}>
        <RowCopy detail="浏览器里打开时没有自动更新。" title="应用更新" />
      </View>
    );
  }
  const action = appUpdateAction(appUpdate, installBlocked);
  const working = appUpdate.phase === "checking" || appUpdate.phase === "downloading";
  const fresh = Boolean(appUpdate.version) && appUpdate.phase !== "up-to-date";
  // 状态文字里已经带了版本号就不再重复；Release 名字就是版本号（v1.6.0）时也不加括号
  const target = appUpdate.version ? `v${appUpdate.version}` : "";
  const releaseLabel = appUpdate.releaseName && appUpdate.releaseName.replace(/^v/iu, "") !== appUpdate.version ? `（${appUpdate.releaseName}）` : "";
  const percent = appUpdate.progress === null ? null : Math.round(Math.max(0, Math.min(100, appUpdate.progress)));
  const run = action?.kind === "download" ? onDownloadAppUpdate : action?.kind === "install" ? onInstallAppUpdate : onCheckAppUpdate;
  return (
    <>
      {appUpdate.currentVersion ? (
        <View style={styles.row}>
          <RowCopy title="当前版本" />
          <Text style={styles.value} testID="settings-version">v{appUpdate.currentVersion}</Text>
        </View>
      ) : null}
      <View style={styles.row}>
        <View style={styles.copy}>
          <Text style={styles.rowTitle}>应用更新</Text>
          <Text accessibilityLiveRegion="polite" style={styles.detail}>{appUpdate.message}</Text>
          {fresh && !appUpdate.message.includes(target) ? <Text style={styles.updateTarget}>可以更新到 {target}{releaseLabel}</Text> : null}
          {appUpdate.error ? <Text accessibilityRole="alert" style={styles.error}>{appUpdate.error}</Text> : null}
          {percent !== null && (appUpdate.phase === "downloading" || appUpdate.phase === "downloaded") ? (
            <View accessibilityLabel={`更新下载进度 ${percent}%`} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percent }} style={styles.progressRow}>
              <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${percent}%` }]} /></View>
              <Text style={styles.progressText}>{percent}%</Text>
            </View>
          ) : null}
        </View>
        {action ? (
          <Button
            appStyle={appStyle}
            busy={working}
            disabled={action.disabled}
            icon={action.kind === "download" ? Download : RefreshCw}
            kind={action.kind === "check" ? "secondary" : "primary"}
            label={action.label}
            onPress={() => void run()}
            testID="settings-update"
          />
        ) : null}
      </View>
    </>
  );
}

// ---------- 小零件 ----------

function RowCopy({ detail, title }: { detail?: string; title: string }) {
  return (
    <View style={styles.copy}>
      <Text style={styles.rowTitle}>{title}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </View>
  );
}

function Toggle({ label, onPress, testID, value }: { label: string; onPress: () => void; testID: string; value: boolean }) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      aria-checked={value}
      onPress={onPress}
      {...spaceKey(onPress)}
      style={[styles.switch, value && styles.switchOn, pointer, ease("background-color,border-color", 140)]}
      testID={testID}
    >
      <View style={[styles.knob, value && styles.knobOn, ease("transform", 140)]} />
    </Pressable>
  );
}

function Button({ accessibilityLabel, appStyle, busy = false, disabled = false, icon: Icon, kind = "secondary", label, onPress, testID }: {
  accessibilityLabel?: string;
  appStyle: AppStyle;
  busy?: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
  kind?: "primary" | "secondary" | "danger";
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  const tone = kind === "primary" ? color.buttonText : kind === "danger" ? color.danger : color.text;
  return (
    <Pressable
      {...role(appStyle, kind === "primary" ? "btn-solid" : "btn small")}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={(state) => [
        styles.button,
        kind === "primary" ? styles.buttonPrimary : kind === "danger" ? styles.buttonDanger : null,
        !disabled && hovered(state) && (kind === "primary" ? styles.buttonPrimaryHover : kind === "danger" ? styles.buttonDangerHover : styles.buttonHover),
        disabled && styles.disabled,
        !disabled && pointer,
        ease("background-color,border-color", 140),
      ]}
      testID={testID}
    >
      {busy ? <ActivityIndicator color={tone} size="small" style={styles.icon16} />
        : Icon ? <View style={styles.icon16}><Icon color={tone} size={15} strokeWidth={1.9} /></View> : null}
      <Text numberOfLines={1} style={[styles.buttonText, { color: tone }]}>{label}</Text>
    </Pressable>
  );
}

/** 四种风格各一张小样，只用色块和细线拼：颜色取各自色板的原值，不跟着当前风格的变量走。圆点和圆圈用 svg 画（海报会把所有圆角压成直角）。 */
function StyleSwatch({ kind }: { kind: AppStyle }) {
  const p = palettes[kind].colors;
  if (kind === "minimal") {
    return (
      <View style={[styles.swatch, { backgroundColor: p.surface, borderColor: p.border }]}>
        <View style={[styles.swSide, { backgroundColor: p.sidebar, borderRightColor: p.border }]} />
        <View style={styles.swMain}>
          <View style={[styles.swBar, { width: 26, height: 4, backgroundColor: p.text }]} />
          <View style={[styles.swBar, { width: "80%", backgroundColor: p.border }]} />
          <View style={[styles.swBar, { width: "58%", backgroundColor: p.border }]} />
        </View>
      </View>
    );
  }
  if (kind === "trace") {
    const night = p.tints[0]!;
    return (
      <View style={[styles.swatch, { backgroundColor: night, borderColor: p.borderSoft }]}>
        <Svg height={12} style={styles.swDot} width={12}><Circle cx={6} cy={6} fill={p.amber} r={4} /></Svg>
        <View style={[styles.swMain, styles.swMainWide]}>
          <View style={[styles.swLine, { width: "74%", backgroundColor: alpha(p.text, 0.85) }]} />
          <View style={[styles.swLine, { width: "52%", backgroundColor: alpha(p.text, 0.5) }]} />
          <View style={[styles.swLine, { width: "64%", backgroundColor: alpha(p.text, 0.3) }]} />
        </View>
      </View>
    );
  }
  if (kind === "archive") {
    return (
      <View style={[styles.swatch, { backgroundColor: p.canvas, borderColor: p.border }]}>
        <Svg height={30} style={styles.swRing} width={30}><Circle cx={15} cy={15} fill="none" r={12} stroke={p.accent} strokeWidth={1} /><Circle cx={15} cy={15} fill={p.accent} r={1.6} /></Svg>
        <View style={[styles.swMain, styles.swMainRing]}>
          <View style={[styles.swLine, { width: "70%", backgroundColor: p.accent }]} />
          <View style={[styles.swLine, { width: "50%", backgroundColor: alpha(p.text, 0.45) }]} />
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.swatch, { backgroundColor: p.canvas, borderColor: p.black }]}>
      <View style={[styles.swBlock, { backgroundColor: p.black }]} />
      <View style={[styles.swOrange, { backgroundColor: p.accent }]} />
      <View style={[styles.swRule, { backgroundColor: p.black }]} />
    </View>
  );
}

/**
 * 版式角色（data-ws）只给另外三种风格，让它们的版式层把面板印成自己的样子（年志的玻璃、海报的粗线按钮……）。
 * 极简的样子已经全在下面按 token 写好；工作台的极简版式层是按角色选元素的，挂上角色它会把危险按钮的红字、
 * 行标题的字重一起改掉，所以极简下一个角色都不挂。
 */
function role(appStyle: AppStyle, ...names: Array<string | false | null | undefined>): ReturnType<typeof ws> {
  return appStyle === "minimal" ? {} : ws(...names);
}

/** RN-web 只在 role=button 上把空格当点击；单选和开关按读屏和键盘的习惯也要能用空格切换 */
function spaceKey(action: () => void): { onKeyDown?: (event: { key?: string; preventDefault?: () => void }) => void } {
  if (!web) return {};
  return {
    onKeyDown: (event) => {
      if (event.key !== " " && event.key !== "Spacebar") return;
      event.preventDefault?.();
      action();
    },
  };
}

type PressState = { pressed: boolean; hovered?: boolean };
function hovered(state: unknown): boolean {
  return Boolean((state as PressState).hovered);
}

const GRID_GAP = 10;

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16, backgroundColor: color.scrim },
  dialog: { overflow: "hidden", backgroundColor: color.surface, borderWidth: 1, borderColor: color.border, borderRadius: radius.large },
  // 海报的框一律是粗墨线
  dialogPoster: { borderWidth: 3 },
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 24, paddingRight: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  title: { flex: 1, fontFamily: font.body, color: color.text, fontSize: 17, lineHeight: 24, fontWeight: "600" },
  close: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: radius.small },
  closeHover: { backgroundColor: color.surfaceMuted },
  scroll: { flexGrow: 0, flexShrink: 1, flexBasis: "auto" },
  body: { paddingHorizontal: 24, paddingBottom: 24 },
  section: { paddingTop: 22 },
  // 节名是一组设置的小标签：比行标题小一号、灰一档
  sectionTitle: { fontFamily: font.body, color: color.textMuted, fontSize: 13, lineHeight: 18, fontWeight: "600", paddingBottom: 8 },
  // 每行：左边标题和一句说明，右边控件；行与行之间一道发丝线
  row: { flexDirection: "row", alignItems: "center", gap: 16, paddingVertical: 14, borderTopWidth: 1, borderTopColor: color.borderSoft },
  rowStacked: { flexDirection: "column", alignItems: "stretch", gap: 12 },
  rowIntro: { flexDirection: "column", alignItems: "flex-start", gap: 6, paddingVertical: 12 },
  copy: { flex: 1, minWidth: 0, gap: 3 },
  rowTitle: { fontFamily: font.body, color: color.text, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  detail: { fontFamily: font.body, color: color.textMuted, fontSize: 12.5, lineHeight: 19 },
  warning: { fontFamily: font.body, color: color.amber, fontSize: 12.5, lineHeight: 19 },
  error: { fontFamily: font.body, color: color.danger, fontSize: 12.5, lineHeight: 19 },
  value: { fontFamily: font.sans, color: color.textSecondary, fontSize: 13, fontVariant: ["tabular-nums"] },
  updateTarget: { fontFamily: font.body, color: color.text, fontSize: 12.5, lineHeight: 19, fontWeight: "500" },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 },
  progressTrack: { flex: 1, height: 4, overflow: "hidden", borderRadius: radius.pill, backgroundColor: color.surfaceMuted },
  progressFill: { height: 4, backgroundColor: color.cyan },
  progressText: { fontFamily: font.sans, color: color.textMuted, fontSize: 12, fontVariant: ["tabular-nums"] },
  // 风格卡：选中的那张描边加粗一档（内边距少一档抵掉，卡片不跳）
  styleGrid: { flexDirection: "row", flexWrap: "wrap", gap: GRID_GAP },
  styleCard: { gap: 6, padding: 8, paddingBottom: 10, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  styleCardHover: { borderColor: color.frame },
  styleCardOn: { padding: 7, paddingBottom: 9, borderWidth: 2, borderColor: color.accent },
  styleNameRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  styleName: { flexShrink: 1, fontFamily: font.body, color: color.textSecondary, fontSize: 13, lineHeight: 18, fontWeight: "500" },
  styleNameOn: { color: color.text, fontWeight: "600" },
  styleDetail: { fontFamily: font.body, color: color.textMuted, fontSize: 12, lineHeight: 17 },
  swatch: { height: 54, overflow: "hidden", flexDirection: "row", borderWidth: 1, borderRadius: radius.small },
  swSide: { width: 20, borderRightWidth: 1 },
  swMain: { flex: 1, justifyContent: "center", gap: 6, paddingHorizontal: 9 },
  swMainWide: { paddingLeft: 4 },
  swMainRing: { paddingLeft: 6 },
  swBar: { height: 3, borderRadius: 2 },
  swLine: { height: 1 },
  swDot: { marginLeft: 9, marginTop: 9 },
  swRing: { alignSelf: "center", marginLeft: 9 },
  swBlock: { width: "38%", height: "100%" },
  swOrange: { position: "absolute", right: 10, top: 9, width: 16, height: 16 },
  swRule: { position: "absolute", left: "38%", right: 0, bottom: 11, height: 3 },
  // 打开报告用：分段按钮，选中的那段墨黑实底
  segment: { flexDirection: "row", flexShrink: 0, padding: 2, gap: 2, borderRadius: radius.small, backgroundColor: color.surfaceMuted },
  segmentItem: { minHeight: 28, justifyContent: "center", paddingHorizontal: 12, borderRadius: radius.small },
  segmentItemHover: { backgroundColor: alpha(color.text, 0.06) },
  segmentItemOn: { backgroundColor: color.button },
  segmentText: { fontFamily: font.sans, color: color.textSecondary, fontSize: 13, fontWeight: "500" },
  segmentTextOn: { color: color.buttonText },
  // 开关：关是浅灰轨道，开是选中色；滑块位置靠 transform 移，过渡 140ms
  switch: { width: 36, height: 20, flexShrink: 0, borderWidth: 1, borderColor: color.frame, borderRadius: radius.pill, backgroundColor: color.frame },
  switchOn: { borderColor: color.accent, backgroundColor: color.accent },
  knob: { position: "absolute", left: 2, top: 2, width: 14, height: 14, borderRadius: radius.pill, backgroundColor: color.white },
  knobOn: { transform: [{ translateX: 16 }] },
  // 账号行
  // 头像和聊天页一样是圆的（不跟档案馆的直角圆角 token）
  avatar: { width: 30, height: 30, flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: 15 },
  avatarText: { fontFamily: font.sans, fontSize: 13, fontWeight: "600" },
  currentTag: { flexShrink: 0, paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: color.surfaceMuted },
  currentText: { fontFamily: font.sans, color: color.textSecondary, fontSize: 12, fontWeight: "500" },
  actions: { flexDirection: "row", flexShrink: 0, gap: 8 },
  // 按钮：次按钮白底细描边，主按钮实底，危险操作红字红描边；禁用 40%
  button: { minHeight: 32, flexShrink: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 12, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  buttonHover: { backgroundColor: color.surfaceMuted },
  buttonPrimary: { borderColor: color.button, backgroundColor: color.button },
  buttonPrimaryHover: { opacity: 0.88 },
  buttonDanger: { borderColor: alpha(color.danger, 0.45) },
  buttonDangerHover: { backgroundColor: color.dangerSoft },
  buttonText: { fontFamily: font.sans, fontSize: 13, lineHeight: 18, fontWeight: "500" },
  disabled: { opacity: 0.4 },
  icon14: { width: 14, height: 14, flexShrink: 0 },
  icon16: { width: 16, height: 16, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  icon18: { width: 18, height: 18, flexShrink: 0 },
});
