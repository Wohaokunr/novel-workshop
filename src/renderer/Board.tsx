import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, ArrowRight, Bot, ChevronDown, MessageCircleQuestion, ChevronUp, CircleHelp, Columns3, Compass, Film, GitFork, Layers, LayoutGrid, Link2, ListOrdered, Magnet, Map as MapIcon, Milestone, MousePointer2, Network, Plus, Rows3, Scan, Sparkles, StickyNote, Trash2, Unlink, UserRound, X, type LucideIcon } from 'lucide-react';
import { ReactFlow, Background, BackgroundVariant, Controls, Handle, MarkerType, MiniMap, NodeResizer, Position, ViewportPortal, applyNodeChanges, type Node, type Edge, type NodeProps, type Connection, type ReactFlowInstance, type NodeChange, type NodePositionChange } from '@xyflow/react';
import type { Workspace, Command, NovelObject, NarrativeScene, CanvasCard, SourceReference, RunRequest } from '../shared/types';
import { alignPositions, assignedCards, canResizeGroup, cardRect, cardSize, collapsedGroupSize, containingGroup, createdGroup, distributePositions, dissolvedGroup, fitGroups, groupSize, isDescendant, layeredLayout, movedCards, orderedCards, rootCards, snapPosition, tidyCards, visibleCardId, visibleLinks, type AlignGuide, type AlignMode, type IdRect, type Placement, type Point, type Rect, type CardSizes, type Size } from '../shared/canvas';
import { Combobox, Field, Kbd, Popover, Select, type ComboItem, type Commit, uid, fire, characters, orderedChapters, orderedScenes, events, colors } from './ui';
import { motionDuration, usePresence } from './interaction';
import { useCompanion, type SummonRequest } from './Companion';
import type { CompanionFocus } from '../shared/companion-types';

type BoardMode = 'canvas' | 'world' | 'story';
type BoardData = {
  label: string; content: string; kind: string; tag?: string; badge?: string; tint?: string; people?: string[]; state?: string;
  collapsed?: boolean; count?: number; dropTarget?: boolean; connectable: boolean;
  toggle?: () => void; resizeStart?: () => void; resizeEnd?: (rect: Rect) => void; canResize?: (rect: Rect) => boolean;
};
type BoardNode = Node<BoardData>;

const kindMeta: Record<string, { label: string; icon: typeof StickyNote }> = {
  note: { label: '灵感便笺', icon: StickyNote }, object: { label: '素材引用', icon: UserRound },
  scene: { label: '叙述场景', icon: Film }, event: { label: '世界事件', icon: Milestone }, group: { label: '灵感分组', icon: Layers },
};

function StoryNode({ data, selected }: NodeProps<BoardNode>) {
  const group = data.kind === 'group';
  const meta = kindMeta[data.kind] ?? kindMeta.note;
  const Icon = meta.icon;
  return <div className={`board-node ${data.kind} ${group ? 'board-group' : ''} ${selected ? 'selected' : ''} ${data.collapsed ? 'collapsed' : ''} ${data.dropTarget ? 'drop-target' : ''}`} style={{ '--node-tint': data.tint || 'var(--accent)' } as React.CSSProperties}>
    {group && !data.collapsed && <NodeResizer isVisible={selected} minWidth={280} minHeight={160} color="var(--accent)" shouldResize={(_, rect) => data.canResize?.(rect) ?? true} onResizeStart={data.resizeStart} onResizeEnd={(_, rect) => data.resizeEnd?.(rect)} />}
    <Handle type="target" position={Position.Top} isConnectable={data.connectable} style={data.connectable ? undefined : { visibility: 'hidden' }} />
    {group ? <div className="group-drag-handle"><Layers className="group-icon" aria-hidden="true"/><div className="group-label"><span>灵感分组</span><strong>{data.label}</strong></div><button className="group-actions nodrag" aria-label={data.collapsed ? '展开分组' : '折叠分组'} title={data.collapsed ? '展开分组' : '折叠分组'} onClick={data.toggle}>{data.collapsed ? <ChevronDown aria-hidden="true"/> : <ChevronUp aria-hidden="true"/>}{data.count}</button></div>
      : <><div className="node-top"><span className="node-kind"><Icon aria-hidden="true"/>{data.tag || meta.label}</span>{data.badge && <span className="node-badge">{data.badge}</span>}</div><strong>{data.label}</strong></>}
    {data.content && !group && <p>{data.content.slice(0, 120)}</p>}
    {data.state && !group && <p className="node-state">{data.state.slice(0, 140)}</p>}
    {!!data.people?.length && <div className="node-people">{data.people.map(person => <span key={person}>{person}</span>)}</div>}
    <Handle type="source" position={Position.Bottom} isConnectable={data.connectable} style={data.connectable ? undefined : { visibility: 'hidden' }} />
  </div>;
}
const nodeTypes = { story: StoryNode };

export interface BoardProps {
  mode: BoardMode; workspace: Workspace; commit: Commit;
  selectedObject: string; selectObject: (id: string) => void;
  selectedScene: string; selectScene: (id: string) => void;
  selectedCard: string; selectCard: (id: string) => void;
  addEvent: (position?: Point) => Promise<string | undefined>;
  addScene: (chapterId?: string, position?: Point) => Promise<string | undefined>;
  askDelete: (command: Command | Command[], title: string) => Promise<unknown>;
  renderObjectForm: (object: NovelObject) => ReactNode;
  renderSceneForm: (scene: NarrativeScene) => ReactNode;
  onOpenReference: (kind: 'object' | 'scene', id: string) => void;
  onOpenCanvas: (kind: 'object' | 'scene', id: string) => void;
  onAssist: (tool: 'character' | 'world' | 'narrative' | 'canvas' | 'theme' | 'continuity', references: SourceReference[]) => void;
  onPrepare: (stage: RunRequest['stage'], references: SourceReference[]) => void;
  showInspector: boolean; inspectorHost: HTMLElement | null; onInspectorChange?: (open: boolean) => void;
}

function absolutePosition(nodes: readonly BoardNode[], id: string): Point {
  let node = nodes.find(item => item.id === id);
  const point = { x: node?.position.x ?? 0, y: node?.position.y ?? 0 };
  while (node?.parentId) {
    node = nodes.find(item => item.id === node!.parentId);
    point.x += node?.position.x ?? 0; point.y += node?.position.y ?? 0;
  }
  return point;
}

function ancestorIds(nodes: readonly BoardNode[], id: string): string[] {
  const result: string[] = [];
  let parent = nodes.find(item => item.id === id)?.parentId;
  while (parent) { result.push(parent); parent = nodes.find(item => item.id === parent)?.parentId; }
  return result;
}

const snapStorageKey = 'novel.board.snap';
const gridStep = 10;

function cardCommands(before: readonly CanvasCard[], after: readonly CanvasCard[]): Command[] {
  return after.filter(card => JSON.stringify(card) !== JSON.stringify(before.find(item => item.id === card.id))).map(value => ({ type: 'putCard', value }));
}

export default function Board({ mode, workspace: w, commit, selectedObject, selectObject, selectedScene, selectScene, selectedCard, selectCard, addEvent, addScene, askDelete, renderObjectForm, renderSceneForm, onOpenReference, onOpenCanvas, onAssist, onPrepare, showInspector, inspectorHost, onInspectorChange }: BoardProps) {
  const activeId = mode === 'canvas' ? selectedCard : mode === 'world' ? selectedObject : selectedScene;
  const flow = useRef<ReactFlowInstance<BoardNode, Edge> | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const gesture = useRef(false);
  const gestureCards = useRef(w.cards);
  const [syncVersion, setSyncVersion] = useState(0);
  const pendingSelection = useRef<string[] | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const detailId = useRef<string | undefined>(undefined);
  const observedActiveId = useRef<string | undefined>(undefined);
  const hoverGroup = useRef<string | undefined>(undefined);
  const workspaceRef = useRef(w); workspaceRef.current = w;
  const [menu, setMenu] = useState<{ point: Point; left: number; top: number; screen: Point; nodeId?: string } | null>(null);
  const companion = useCompanion();
  const [snap, setSnap] = useState(() => { try { return localStorage.getItem(snapStorageKey) !== 'off'; } catch { return true; } });
  const [guides, setGuides] = useState<AlignGuide[]>([]);
  /** Positions adjusted by alignment snapping; React Flow reports its own unsnapped positions when the drag ends. */
  const snapped = useRef(new Map<string, Point>());
  const [arranging, setArranging] = useState(false);
  const lastMenu = useRef(menu); if (menu) lastMenu.current = menu;
  const menuPresence = usePresence(!!menu, 120);
  const shownMenu = menu ?? (menuPresence.mounted ? lastMenu.current : null);
  const chars = characters(w), es = events(w), scenes = orderedScenes(w);
  const threads = [...new Set(es.map(object => object.event!.thread || '主线'))];
  const times = [...new Set(es.map(object => object.event!.worldOrder))].sort((a, b) => a - b);
  const widths = threads.map(thread => Math.max(1, ...times.map(time => es.filter(object => (object.event!.thread || '主线') === thread && object.event!.worldOrder === time).length)) * 255 + 20);
  const card = w.cards.find(item => item.id === selectedCard);
  const object = w.objects.find(item => item.id === selectedObject);
  const scene = w.scenes.find(item => item.id === selectedScene);
  const objectDescription = (value: NovelObject): string => {
    const fieldId = typeof value.fields.description === 'string' ? 'description' : w.objectTypes.find(type => type.id === value.typeId)?.fields.find(field => field.kind === 'text')?.id;
    return fieldId && typeof value.fields[fieldId] === 'string' ? value.fields[fieldId] as string : '';
  };
  const cardTitle = (value: CanvasCard): string => value.kind === 'object' ? w.objects.find(object => object.id === value.refId)?.name || value.title : value.kind === 'scene' ? w.scenes.find(scene => scene.id === value.refId)?.title || value.title : value.title;
  const stateSummary = (value: NovelObject): string => {
    if (value.typeId === 'character') {
      const latest = (w.characterStates ?? []).filter(state => state.characterId === value.id).sort((a, b) => (es.find(event => event.id === b.eventId)?.event!.worldOrder ?? -1) - (es.find(event => event.id === a.eventId)?.event!.worldOrder ?? -1))[0];
      return latest ? `心理：${latest.psychology} · 视角：${latest.perspective}` : '';
    }
    return value.event ? (w.characterStates ?? []).filter(state => state.eventId === value.id).map(state => `${chars.find(character => character.id === state.characterId)?.name || '人物'}：${state.psychology}`).join('；') : '';
  };

  const beginGesture = () => { gesture.current = true; gestureCards.current = workspaceRef.current.cards; setMenu(null); };
  const finishGesture = () => { gesture.current = false; hoverGroup.current = undefined; setSyncVersion(value => value + 1); };
  const select = (id: string) => { detailId.current = id; if (mode === 'canvas') selectCard(id); else if (mode === 'world') selectObject(id); else selectScene(id); };
  const requestSelection = async (ids: string[]) => {
    const target = ids[0] ?? '';
    select(target);
    const ancestors = mode === 'canvas' ? workspaceRef.current.cards.filter(card => card.collapsed && ids.some(id => isDescendant(workspaceRef.current.cards, id, card.id))) : [];
    if (ancestors.length) await commit(current => current.cards.filter(card => ancestors.some(parent => parent.id === card.id)).map(value => ({ type: 'putCard', value: { ...value, collapsed: false } })), '展开目标所在分组');
    if (detailId.current !== target) return;
    pendingSelection.current = ids; pendingFocus.current = target || null; setSyncVersion(value => value + 1);
  };
  const sizes = (): CardSizes => {
    const measured = new Map<string, Size>();
    for (const node of flow.current?.getNodes() ?? []) if (node.measured?.width && node.measured?.height) measured.set(node.id, { width: node.measured.width, height: node.measured.height });
    return measured;
  };
  const parentOffset = (cards: readonly CanvasCard[], id: string): Point => {
    const parent = cards.find(item => item.id === cards.find(item => item.id === id)?.groupId);
    return { x: parent?.x ?? 0, y: parent?.y ?? 0 };
  };

  const worldDefault = (value: NovelObject): Point => {
    const lane = threads.indexOf(value.event!.thread || '主线');
    const parallel = es.filter(item => (item.event!.thread || '主线') === (value.event!.thread || '主线') && item.event!.worldOrder === value.event!.worldOrder).findIndex(item => item.id === value.id);
    return { x: widths.slice(0, lane).reduce((sum, width) => sum + width, 40) + parallel * 255, y: times.indexOf(value.event!.worldOrder) * 250 + 65 };
  };
  const povLane = (value: NarrativeScene) => { const found = chars.findIndex(character => character.id === value.povId); return found < 0 ? chars.length : found; };
  const storyDefault = (value: NarrativeScene, index: number): Point => ({ x: povLane(value) * 275 + 40, y: index * 250 + 65 });

  const generated = useMemo(() => {
    let graphNodes: BoardNode[] = [], edges: Edge[] = [];
    if (mode === 'canvas') {
      graphNodes = orderedCards(w.cards).map(item => {
        const parent = w.cards.find(group => group.id === item.groupId);
        const ref = item.kind === 'object' ? w.objects.find(value => value.id === item.refId) : item.kind === 'scene' ? w.scenes.find(value => value.id === item.refId) : undefined;
        const group = item.kind === 'group';
        const size = item.collapsed ? collapsedGroupSize : { width: item.width ?? groupSize.width, height: item.height ?? groupSize.height };
        return {
          id: item.id, type: 'story', position: { x: item.x - (parent?.x ?? 0), y: item.y - (parent?.y ?? 0) },
          ...(parent ? { parentId: parent.id } : {}), hidden: visibleCardId(w.cards, item.id) !== item.id,
          ...(group ? { style: size, dragHandle: '.group-drag-handle', zIndex: -1 } : {}),
          data: {
            label: cardTitle(item),
            content: [ref && 'name' in ref ? objectDescription(ref) : ref && 'outline' in ref ? ref.outline : '', item.content ? `${ref ? '备注：' : ''}${item.content}` : ''].filter(Boolean).join('\n'),
            state: ref && 'name' in ref ? stateSummary(ref) : undefined,
            kind: item.kind, collapsed: item.collapsed, connectable: true,
            count: group ? w.cards.filter(member => isDescendant(w.cards, member.id, item.id)).length : undefined,
            toggle: group ? () => { fire(commit(current => { const value = current.cards.find(value => value.id === item.id); return value ? [{ type: 'putCard', value: { ...value, collapsed: !value.collapsed } }] : []; }, '折叠 / 展开分组').then(() => requestSelection([item.id]))); } : undefined,
            resizeStart: beginGesture,
            canResize: (rect: Rect) => { const offset = parentOffset(gestureCards.current, item.id); return canResizeGroup(gestureCards.current, item.id, { ...rect, x: rect.x + offset.x, y: rect.y + offset.y }, sizes()); },
            resizeEnd: (rect: Rect) => {
              const offset = parentOffset(gestureCards.current, item.id);
              fire(commit(current => cardCommands(current.cards, fitGroups(current.cards.map(value => value.id === item.id ? { ...value, ...rect, x: rect.x + offset.x, y: rect.y + offset.y } : value), sizes())), '调整分组尺寸').finally(finishGesture));
            },
          },
        };
      });
      edges = visibleLinks(w.cards, w.canvasLinks).map(link => ({ id: link.id, source: link.source, target: link.target, data: { linkIds: link.linkIds }, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: 'var(--edge)', strokeWidth: 1.5, ...(link.proxy ? { strokeDasharray: '5 4' } : {}) }, label: link.proxy && link.linkIds.length > 1 ? `${link.linkIds.length} 条关联` : undefined }));
    } else if (mode === 'world') {
      graphNodes = es.map(value => {
        const lane = threads.indexOf(value.event!.thread || '主线');
        return { id: value.id, type: 'story', position: w.layouts[`world:${value.id}`] || worldDefault(value), data: { label: value.name, content: objectDescription(value) || value.event!.thread, state: stateSummary(value), kind: 'event', connectable: true, tag: value.event!.timeLabel || '世界事件', badge: `#${value.event!.worldOrder}${value.event!.critical ? ' · 关键' : ''}`, tint: colors[lane % colors.length], people: value.event!.participants.map(id => chars.find(character => character.id === id)?.name || '未命名人物') } };
      });
      edges = es.flatMap(value => value.event!.causes.map(cause => ({ id: `cause:${cause}:${value.id}`, source: cause, target: value.id, type: 'smoothstep', style: { stroke: colors[threads.indexOf(value.event!.thread || '主线') % colors.length], strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed } })));
    } else {
      graphNodes = scenes.map((value, index) => {
        const lane = povLane(value);
        return { id: value.id, type: 'story', position: w.layouts[`story:${value.id}`] || storyDefault(value, index), data: { label: value.title, content: value.outline, kind: 'scene', connectable: false, tag: w.chapters.find(chapter => chapter.id === value.chapterId)?.title || '叙述场景', badge: `阅读 ${index + 1}`, tint: colors[lane % colors.length], people: [chars.find(character => character.id === value.povId)?.name || '全知 / 外部视角', `${value.eventIds.length} 个世界事件`] } };
      });
      edges = scenes.slice(1).map((value, index) => ({ id: `next:${scenes[index].id}:${value.id}`, source: scenes[index].id, target: value.id, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: colors[(value.povId ? chars.findIndex(character => character.id === value.povId) : chars.length) % colors.length], strokeWidth: 2 } }));
    }
    return { nodes: graphNodes, edges };
  }, [w, mode]);
  const [nodes, setNodes] = useState<BoardNode[]>(() => generated.nodes.map(node => ({ ...node, selected: node.id === (mode === 'canvas' ? selectedCard : mode === 'world' ? selectedObject : selectedScene) })));
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const [edges, setEdges] = useState(generated.edges);
  useEffect(() => {
    if (gesture.current) return;
    const selected = pendingSelection.current;
    pendingSelection.current = null;
    setNodes(previous => generated.nodes.map(node => {
      const old = previous.find(value => value.id === node.id);
      return { ...node, selected: !node.hidden && (selected ? selected.includes(node.id) : old?.selected ?? false), measured: old?.measured };
    }));
    setEdges(generated.edges);
    const focusId = pendingFocus.current;
    if (focusId && generated.nodes.some(node => node.id === focusId && !node.hidden)) {
      pendingFocus.current = null;
      requestAnimationFrame(() => { void flow.current?.fitView({ nodes: [{ id: focusId }], padding: 0.6, maxZoom: 1.2, duration: motionDuration(180) }); });
    }
  }, [generated, syncVersion]);
  useEffect(() => {
    if (observedActiveId.current === activeId) return;
    observedActiveId.current = activeId;
    if (activeId === detailId.current || (activeId && !generated.nodes.some(node => node.id === activeId))) return;
    fire(requestSelection(activeId ? [activeId] : []));
  }, [activeId, generated]);

  const selectedIds = nodes.filter(node => node.selected && !node.hidden).map(node => node.id);
  const sourceReferences = (ids: readonly string[]): SourceReference[] => ids.map(id => ({ kind: mode === 'canvas' ? 'card' : mode === 'world' ? 'object' : 'scene', id }));
  const viewCenter = (): Point => {
    const rect = container.current?.getBoundingClientRect();
    return rect && flow.current ? flow.current.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 180, y: 140 };
  };
  const createCard = (kind: CanvasCard['kind'], refId?: string, point = viewCenter()) => {
    const id = uid(), size = kind === 'group' ? groupSize : cardSize;
    fire(commit(current => {
      const group = containingGroup(current.cards, point, [], sizes());
      const value: CanvasCard = { id, kind, refId, title: kind === 'group' ? '新的分组' : '新的灵感', content: '', x: point.x - size.width / 2, y: point.y - size.height / 2, groupId: group?.id };
      return cardCommands(current.cards, fitGroups([...current.cards, value], sizes()));
    }, '添加画布卡片').then(async () => { onInspectorChange?.(true); await requestSelection([id]); }));
    setMenu(null);
  };
  const createSceneOrEvent = (point = viewCenter()) => {
    fire((mode === 'world' ? addEvent({ x: point.x - cardSize.width / 2, y: point.y - cardSize.height / 2 }) : addScene(scene?.chapterId, { x: point.x - cardSize.width / 2, y: point.y - cardSize.height / 2 })).then(async id => { if (id) { onInspectorChange?.(true); await requestSelection([id]); } }));
    setMenu(null);
  };
  const groupSelection = () => {
    if (!selectedIds.length) { createCard('group'); return; }
    const id = uid(), ids = [...selectedIds];
    fire(commit(current => cardCommands(current.cards, createdGroup(current.cards, ids, id, sizes())), '将选中卡片分组').then(async () => { onInspectorChange?.(true); await requestSelection([id]); }));
  };
  const assign = (ids: string[], groupId?: string) => fire(commit(current => cardCommands(current.cards, assignedCards(current.cards, ids, groupId, sizes())), groupId ? '移入分组' : '移出分组'));
  const dissolve = (id: string) => fire(commit(current => [...cardCommands(current.cards, dissolvedGroup(current.cards, id)), { type: 'deleteCard', id }], '解散分组').then(() => { selectCard(''); requestSelection([]); }));

  const dragged = (items: BoardNode[]): BoardNode[] => nodesRef.current.map(node => items.find(item => item.id === node.id) ?? node);
  const dragMove = (items: BoardNode[]) => {
    if (mode !== 'canvas' || !items.length) return;
    const snapshot = dragged(items), node = items[0], point = absolutePosition(snapshot, node.id);
    const size = node.measured ?? cardSize;
    const candidate = containingGroup(gestureCards.current, { x: point.x + (size.width ?? cardSize.width) / 2, y: point.y + (size.height ?? cardSize.height) / 2 }, items.map(item => item.id), sizes());
    if (hoverGroup.current === candidate?.id) return;
    hoverGroup.current = candidate?.id;
    setNodes(previous => previous.map(item => ({ ...item, data: { ...item.data, dropTarget: item.id === candidate?.id } })));
  };
  const dragStop = (items: BoardNode[]) => {
    const snapshot = dragged(items);
    const points = items.map(node => ({ id: node.id, ...absolutePosition(snapshot, node.id) }));
    fire(commit(current => {
      if (mode !== 'canvas') return points.map(point => ({ type: 'setLayout', key: `${mode}:${point.id}`, value: { x: point.x, y: point.y } }));
      const moved = movedCards(current.cards, points), next = current.cards.map(value => moved.find(item => item.id === value.id) ?? value);
      const roots = rootCards(next, points.map(point => point.id));
      const groups = new Map(roots.map(value => {
        const rect = cardRect(value, sizes());
        return [value.id, containingGroup(next, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, roots.map(root => root.id), sizes())?.id];
      }));
      return cardCommands(current.cards, fitGroups(next.map(value => groups.has(value.id) ? { ...value, groupId: groups.get(value.id) } : value), sizes()));
    }, mode === 'canvas' ? '移动画布卡片' : '调整图布局').finally(finishGesture));
  };
  const connect = (connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const source = connection.source, target = connection.target;
    if (mode === 'canvas') fire(commit(current => current.canvasLinks.some(link => link.source === source && link.target === target) ? [] : [{ type: 'putCanvasLink', value: { id: uid(), source, target } }], '连接灵感'));
    else if (mode === 'world') fire(commit(current => { const value = current.objects.find(value => value.id === target); return value?.event ? [{ type: 'putObject', value: { ...value, event: { ...value.event, causes: [...new Set([...value.event.causes, source])] } } }] : []; }, '编排世界因果'));
  };
  const deleteSelection = () => {
    fire(askDelete(selectedIds.map(id => mode === 'canvas' ? { type: 'deleteCard', id } : mode === 'world' ? { type: 'deleteObject', id } : { type: 'deleteScene', id }), `删除选中的 ${selectedIds.length} 个${mode === 'canvas' ? '卡片' : mode === 'world' ? '世界事件' : '场景'}`));
  };
  const patchCard = (id: string, patch: Partial<CanvasCard>) => commit(current => { const value = current.cards.find(item => item.id === id); return value ? [{ type: 'putCard', value: { ...value, ...patch } }] : []; });
  const convertNote = (typeId?: string) => {
    if (!card) return;
    const id = uid();
    fire(commit(current => {
      const value = current.cards.find(item => item.id === card.id); if (!value) return [];
      if (typeId) {
        const textField = current.objectTypes.find(type => type.id === typeId)?.fields.find(field => field.kind === 'text');
        return [{ type: 'putObject', value: { id, typeId, name: value.title, fields: textField ? { [textField.id]: value.content } : {}, ...(typeId === 'event' ? { event: { worldOrder: Math.max(0, ...events(current).map(event => event.event!.worldOrder)) + 1, timeLabel: '', thread: '主线', participants: [], causes: [], critical: false, observations: {} } } : {}) } }, { type: 'putCard', value: { ...value, kind: 'object', refId: id, content: textField ? '' : value.content } }];
      }
      const chapter = orderedChapters(current)[0] ?? { id: uid(), title: '第一章', order: 1 };
      const commands: Command[] = current.chapters.length ? [] : [{ type: 'putChapter', value: chapter }];
      commands.push({ type: 'putScene', value: { id, chapterId: chapter.id, order: Math.max(0, ...current.scenes.filter(scene => scene.chapterId === chapter.id).map(scene => scene.order)) + 1, title: value.title, povId: null, eventIds: [], outline: value.content, text: '' } }, { type: 'putCard', value: { ...value, kind: 'scene', refId: id, content: '' } });
      return commands;
    }, typeId ? '便笺转换为小说对象' : '便笺转换为叙述场景'));
  };
  const referenceObject = card?.kind === 'object' ? w.objects.find(value => value.id === card.refId) : undefined;
  const referenceScene = card?.kind === 'scene' ? w.scenes.find(value => value.id === card.refId) : undefined;
  const availableGroups = w.cards.filter(value => value.kind === 'group' && !selectedIds.some(id => id === value.id || isDescendant(w.cards, value.id, id)));
  const scopeCardIds = new Set(card ? [card.id, ...(card.kind === 'group' ? w.cards.filter(value => isDescendant(w.cards, value.id, card.id)).map(value => value.id) : [])] : []);
  const relatedCardIds = new Set([...scopeCardIds, ...w.canvasLinks.filter(link => scopeCardIds.has(link.source) || scopeCardIds.has(link.target)).flatMap(link => [link.source, link.target])]);
  const relatedCards = w.cards.filter(value => relatedCardIds.has(value.id));
  const relatedObjectIds = new Set(relatedCards.filter(value => value.kind === 'object').map(value => value.refId));
  const relatedSceneIds = new Set(relatedCards.filter(value => value.kind === 'scene').map(value => value.refId));
  const referencedScenes = scenes.filter(value => relatedSceneIds.has(value.id));
  const relatedEvents = es.filter(value => relatedObjectIds.has(value.id) || value.event!.participants.some(id => relatedObjectIds.has(id)) || referencedScenes.some(scene => scene.eventIds.includes(value.id)));
  const relatedScenes = scenes.filter(value => relatedSceneIds.has(value.id) || (value.povId && relatedObjectIds.has(value.povId)) || value.eventIds.some(id => relatedEvents.some(event => event.id === id)));
  const selectedStoryScene = mode === 'story' && selectedIds.length === 1 ? scenes.find(value => value.id === selectedIds[0]) : undefined;
  const hasSelectedGroup = mode === 'canvas' && w.cards.some(value => value.kind === 'group' && selectedIds.includes(value.id));
  const canvasLabel = (kind: 'object' | 'scene', id: string) => w.cards.some(value => value.kind === kind && value.refId === id) ? '在画布定位' : '添加到画布';

  const [minimap, setMinimap] = useState(false);
  const noun = mode === 'canvas' ? '卡片' : mode === 'world' ? '事件' : '场景';
  const fit = () => { void flow.current?.fitView({ padding: 0.2, maxZoom: 1.2, duration: motionDuration(200) }); };
  const clearSelection = () => { setNodes(previous => previous.map(node => node.selected ? { ...node, selected: false } : node)); select(''); };

  /* ---------- alignment, snapping, automatic layout ---------- */
  const nodeRect = (node: BoardNode): IdRect => ({ id: node.id, ...absolutePosition(nodesRef.current, node.id), width: node.measured?.width ?? cardSize.width, height: node.measured?.height ?? cardSize.height });
  const toggleSnap = () => setSnap(value => { try { localStorage.setItem(snapStorageKey, value ? 'off' : 'on'); } catch { /* preference only */ } return !value; });
  /** While one node is dragged, pull it onto the edges and centers of nearby nodes and show guides. */
  const nodesChange = (changes: NodeChange<BoardNode>[]) => {
    const moves = changes.filter((change): change is NodePositionChange => change.type === 'position' && !!change.dragging && !!change.position);
    if (snap && moves.length === 1 && flow.current) {
      const move = moves[0]!, current = nodesRef.current, node = current.find(item => item.id === move.id);
      if (node) {
        const offset = node.parentId ? absolutePosition(current, node.parentId) : { x: 0, y: 0 };
        const related = new Set(ancestorIds(current, node.id));
        const others = current.filter(other => other.id !== node.id && !other.hidden && !related.has(other.id) && !ancestorIds(current, other.id).includes(node.id)).map(nodeRect);
        const result = snapPosition({ ...nodeRect(node), x: move.position!.x + offset.x, y: move.position!.y + offset.y }, others, 6 / flow.current.getZoom());
        // Without a nearby edge, fall back to the grid; multi-node drags stay free so relative positions never drift.
        const grid = (value: number) => Math.round(value / gridStep) * gridStep;
        const x = result.guides.some(guide => guide.orientation === 'vertical') ? result.x : grid(result.x);
        const y = result.guides.some(guide => guide.orientation === 'horizontal') ? result.y : grid(result.y);
        move.position = { x: x - offset.x, y: y - offset.y };
        snapped.current.set(node.id, move.position);
        setGuides(result.guides);
      }
    } else if (moves.length > 1 && guides.length) setGuides([]);
    setNodes(previous => applyNodeChanges(changes, previous));
  };
  /** Commit a layout change and let nodes glide to their new places. */
  const arrange = (label: string, build: (current: Workspace) => Command[], fitAfter = true) => {
    setMenu(null); setArranging(true);
    fire(commit(build, label).finally(() => window.setTimeout(() => { setArranging(false); if (fitAfter) fit(); }, motionDuration(340))));
  };
  const layoutCommands = (points: readonly Placement[]): Command[] => points.map(point => ({ type: 'setLayout', key: `${mode}:${point.id}`, value: { x: Math.round(point.x), y: Math.round(point.y) } }));
  const nodeSize = (id: string): Size => { const node = nodesRef.current.find(item => item.id === id); return { width: node?.measured?.width ?? 220, height: node?.measured?.height ?? cardSize.height }; };
  const tidyCanvas = (ids?: string[], cluster = false) => arrange(ids ? '整理选中卡片' : cluster ? '按关联整理画布' : '自动整理画布',
    current => cardCommands(current.cards, tidyCards(current.cards, { sizes: sizes(), links: current.canvasLinks, ids, cluster })), !ids);
  const arrangeActions: Array<{ icon: LucideIcon; label: string; hint: string; run: () => void; disabled?: boolean }> = mode === 'canvas' ? [
    { icon: LayoutGrid, label: '自动整理全部', hint: '分组内收紧排列，整体按阅读顺序排成网格', run: () => tidyCanvas(), disabled: !w.cards.length },
    { icon: Network, label: '按关联聚类', hint: '有连线的卡片排在一起，各簇再整体排布', run: () => tidyCanvas(undefined, true), disabled: !w.cards.length },
    { icon: Rows3, label: '整理选中卡片', hint: '只排列已选卡片与其分组内容', run: () => tidyCanvas([...selectedIds]), disabled: !selectedIds.length },
  ] : mode === 'world' ? [
    { icon: GitFork, label: '按因果分层', hint: '前因在上、后果在下，尽量减少连线交叉', disabled: !es.length,
      run: () => arrange('按因果分层整理', current => layoutCommands(layeredLayout(events(current).map(value => value.id), events(current).flatMap(value => value.event!.causes.map(cause => [cause, value.id] as const)), nodeSize))) },
    { icon: Columns3, label: '按支线泳道', hint: '每条支线一列，按世界顺序自上而下', disabled: !es.length, run: () => arrange('按支线泳道整理', () => layoutCommands(es.map(value => ({ id: value.id, ...worldDefault(value) })))) },
  ] : [
    { icon: ListOrdered, label: '按视角泳道', hint: '每个视角人物一列，按阅读顺序自上而下', disabled: !scenes.length, run: () => arrange('按视角泳道整理', () => layoutCommands(scenes.map((value, index) => ({ id: value.id, ...storyDefault(value, index) })))) },
    { icon: Rows3, label: '按章节分行', hint: '每章一行，场景按阅读顺序从左到右', disabled: !scenes.length, run: () => arrange('按章节整理叙述顺序', current => {
      let y = 65;
      return layoutCommands(orderedChapters(current).flatMap(chapter => {
        const row = orderedScenes(current).filter(value => value.chapterId === chapter.id);
        if (!row.length) return [];
        const top = y; y += Math.max(...row.map(value => nodeSize(value.id).height)) + 80;
        return row.map((value, column) => ({ id: value.id, x: 40 + column * 270, y: top }));
      }));
    }) },
  ];
  const alignSelection = (how: AlignMode | 'x' | 'y') => {
    const ids = [...selectedIds];
    const place = (rects: IdRect[]) => how === 'x' || how === 'y' ? distributePositions(rects, how) : alignPositions(rects, how);
    const label = how === 'x' ? '水平等距分布' : how === 'y' ? '垂直等距分布' : `对齐选中${noun}`;
    if (mode === 'canvas') arrange(label, current => {
      const moved = movedCards(current.cards, place(rootCards(current.cards, ids).map(card => ({ id: card.id, ...cardRect(card, sizes()) }))));
      return cardCommands(current.cards, fitGroups(current.cards.map(value => moved.find(item => item.id === value.id) ?? value), sizes()));
    }, false);
    else arrange(label, () => layoutCommands(place(nodesRef.current.filter(node => ids.includes(node.id)).map(nodeRect))), false);
  };
  const alignActions: Array<{ how: AlignMode | 'x' | 'y'; icon: LucideIcon; label: string; min: number }> = [
    { how: 'left', icon: AlignStartVertical, label: '左对齐', min: 2 }, { how: 'hcenter', icon: AlignCenterVertical, label: '水平居中', min: 2 }, { how: 'right', icon: AlignEndVertical, label: '右对齐', min: 2 },
    { how: 'top', icon: AlignStartHorizontal, label: '顶部对齐', min: 2 }, { how: 'vcenter', icon: AlignCenterHorizontal, label: '垂直居中', min: 2 }, { how: 'bottom', icon: AlignEndHorizontal, label: '底部对齐', min: 2 },
    { how: 'x', icon: AlignHorizontalDistributeCenter, label: '水平等距分布', min: 3 }, { how: 'y', icon: AlignVerticalDistributeCenter, label: '垂直等距分布', min: 3 },
  ];
  const referenceItems: ComboItem[] = [
    ...w.objects.map(value => ({ id: `object:${value.id}`, label: value.name, group: value.event ? '世界事件' : w.objectTypes.find(type => type.id === value.typeId)?.name ?? '小说素材', hint: w.cards.some(item => item.kind === 'object' && item.refId === value.id) ? '已在画布' : undefined })),
    ...scenes.map(value => ({ id: `scene:${value.id}`, label: value.title, group: '叙述场景', hint: w.cards.some(item => item.kind === 'scene' && item.refId === value.id) ? '已在画布' : w.chapters.find(chapter => chapter.id === value.chapterId)?.title })),
  ];
  const addReference = (item: ComboItem, point?: Point) => { const [kind, ...id] = item.id.split(':'); createCard(kind as CanvasCard['kind'], id.join(':'), point); };
  /** Board-wide actions: the light partner first (in place, one-click adopt); multi-step work goes to the agent. */
  const boardActions: Array<{ label: string; run: (screen: Point) => void; disabled?: boolean; agent?: boolean }> = mode === 'canvas'
    ? [{ label: '发散整张画布', run: screen => summon(screen, [], '看看画布上已有的灵感，往几个截然不同的方向发散。', '发散整张画布') },
      { label: '补全人物阵容', run: screen => summon(screen, [], '根据画布上的灵感和作品信息，补充推动故事的人物，并理清他们的关系。', '补全人物阵容', 'develop', undefined, 'cast') },
      { label: '梳理关联并连线', run: screen => summon(screen, w.cards.filter(value => value.kind !== 'group').slice(0, 12).map(value => ({ kind: 'card' as const, id: value.id })), linkMessage, '梳理关联并连线'), disabled: w.cards.filter(value => value.kind !== 'group').length < 2 },
      { label: '推断作品立意', run: screen => summon(screen, [], '根据画布上的灵感推断几个立意方向。', '作品立意', 'develop', undefined, 'theme') }]
    : mode === 'world' ? [{ label: '这里还缺什么事件？', run: screen => summon(screen, [], '看看现有的世界事件，还缺哪些关键的前因或后果？', '推演因果') },
      { label: '根据世界事件展开大纲', run: screen => summon(screen, sourceReferences(es.slice(-12).map(value => value.id)), '根据这些世界事件，安排读者看到的章节与场景。', '展开大纲', 'outline'), disabled: !es.length }]
    : [{ label: '诊断整体结构', run: screen => summon(screen, [], '诊断整个故事目前的叙述结构与节奏。', '诊断结构') },
      { label: '检查场景一致性', run: () => onAssist('continuity', []), agent: true }];
  const nodeTitle = (id: string) => mode === 'canvas' ? cardTitle(w.cards.find(value => value.id === id) ?? { id, kind: 'note', title: '这张卡片', content: '', x: 0, y: 0 })
    : mode === 'world' ? w.objects.find(value => value.id === id)?.name ?? '这件事' : w.scenes.find(value => value.id === id)?.title ?? '这个场景';
  const companionMode: SummonRequest['mode'] = mode === 'canvas' ? 'diverge' : mode === 'world' ? 'causality' : 'structure';
  const linkMessage = '梳理这些卡片之间的关系，用 link 把相关的连起来，关系写进 title；需要时补充人物。';
  const summon = (screen: Point, refs: SourceReference[], message?: string, label?: string, kind: SummonRequest['mode'] = companionMode, point?: Point, focus?: CompanionFocus) => {
    setMenu(null);
    companion.summon({ mode: kind, anchor: { surface: mode, references: refs, ...(point ? { point } : {}), ...(focus ? { focus } : {}), ...(kind === 'outline' ? { outlineNode: { kind: 'book' as const } } : {}) }, screen, ...(message ? { message } : {}), label });
  };
  const below = (event: React.MouseEvent<HTMLElement>): Point => { const rect = event.currentTarget.getBoundingClientRect(); return { x: rect.left, y: rect.bottom }; };
  const above = (event: React.MouseEvent<HTMLElement>): Point => { const rect = event.currentTarget.getBoundingClientRect(); return { x: rect.left, y: rect.top - 8 }; };
  /** Each graph offers its own way into the partner: divergence on the canvas, causality on the world graph, structure on the reading order. */
  const nodePrompts = (id: string): Array<{ label: string; message?: string; kind?: SummonRequest['mode']; focus?: CompanionFocus }> => {
    const title = nodeTitle(id);
    if (mode === 'canvas') return [
      { label: '围绕它发散', message: `围绕「${title}」发散，给我几个方向截然不同的点子。` },
      { label: '补充相关人物', message: `「${title}」牵涉到哪些人物？补充需要的人物，并和它连起来。`, kind: 'develop', focus: 'cast' },
      { label: '如果它反过来？', message: `What-if：如果「${title}」完全反过来，故事会怎样？` },
      { label: '反转它', message: `给「${title}」设计几个出人意料、但回头看合情合理的反转。` },
      { label: '追问我', message: `先别给点子，围绕「${title}」问我几个关键问题，帮我想清楚它在故事里的意义。` },
    ];
    if (mode === 'world') return [
      { label: '推演后果', message: `「${title}」之后会发生什么？推演两到三步后果。` },
      { label: '补一个前因', message: `「${title}」背后还缺什么前因？给我几个可能的起点。` },
      { label: '如果它没发生', message: `如果「${title}」没有发生，世界和人物会怎样？给出替代走向。` },
      { label: '围绕它发散', message: `围绕「${title}」发散，这件事还能牵出什么？`, kind: 'diverge' },
    ];
    return [
      { label: '诊断这一段的节奏', message: `诊断「${title}」所在段落的节奏与信息揭露。` },
      { label: '换个开篇', message: '如果换一个开篇，可以怎样重排这些场景？' },
      { label: '推迟这里的揭露', message: `「${title}」揭露的信息是否太早？给出推迟揭露的方案。` },
      { label: '这里之后还能加什么', message: `在「${title}」之后还可以加入什么场景，让节奏更有起伏？` },
    ];
  };
  const panePrompts: Array<{ label: string; message?: string }> = mode === 'canvas'
    ? [{ label: '在这里发散…' }, { label: '追问我（苏格拉底）', message: '先别给点子，问我几个关键问题，帮我想清楚这个故事最想写什么。' }]
    : mode === 'world' ? [{ label: '这里还缺什么事件？', message: '看看现有的世界事件，还缺哪些关键的前因或后果？' }]
    : [{ label: '诊断整体结构', message: '诊断整个故事目前的叙述结构与节奏。' }];
  const summonForSelection = () => {
    const id = selectedIds[0]; if (!id || !flow.current) return;
    const node = nodes.find(value => value.id === id), position = absolutePosition(nodes, id);
    const screen = flow.current.flowToScreenPosition({ x: position.x + (node?.measured?.width ?? cardSize.width), y: position.y });
    summon(screen, sourceReferences(selectedIds), undefined, selectedIds.length > 1 ? `已选 ${selectedIds.length} 个${noun}` : nodeTitle(id));
  };
  const legend = mode === 'canvas' ? [] : (mode === 'world' ? threads : [...chars.map(value => value.name), '全知 / 外部视角']);
  const shortcuts: Array<[string, string]> = [
    ['N', mode === 'canvas' ? '在视口中心添加便笺' : `添加${mode === 'world' ? '世界事件' : '场景'}`], ['F', '适应视图'], ['L', '自动整理布局'], ['拖动', '吸附到其他卡片的边与中线'], ['Ctrl A', '全选'], ['Ctrl 点击', '多选'], ['Shift 拖曳', '框选'],
    ['空格 拖曳', '平移画布'], ['I', '围绕选中内容唤出创作伙伴'], ['右键', '在指针处唤出创作伙伴'], ['方向键', '微调位置（Shift 加大步长）'], ['Delete', '删除选中'], ['Esc', '取消选择'],
    ...(mode === 'canvas' ? [['Ctrl G', '将选中卡片成组'], ['双击空白', '添加便笺'], ['右键空白', '在指针处添加']] as Array<[string, string]> : []),
  ];

  return <div className={`board-page mode-${mode}`} onKeyDownCapture={event => {
    const direction = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[event.key];
    if (!direction || !(event.target as HTMLElement).closest('.react-flow__node,.react-flow__nodesselection-rect') || !selectedIds.length) return;
    event.preventDefault(); event.stopPropagation();
    const roots = mode === 'canvas' ? rootCards(w.cards, selectedIds).map(card => card.id) : selectedIds;
    const step = event.shiftKey ? 20 : 5;
    const items = nodes.filter(node => roots.includes(node.id)).map(node => ({ ...node, position: { x: node.position.x + direction[0] * step, y: node.position.y + direction[1] * step } }));
    beginGesture(); setNodes(previous => previous.map(node => items.find(item => item.id === node.id) ?? node)); dragStop(items);
  }} onKeyDown={event => {
    if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"],.popover-panel,.board-create-menu')) return;
    const key = event.key.toLowerCase(), plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length) { event.preventDefault(); deleteSelection(); }
    else if ((event.ctrlKey || event.metaKey) && key === 'g' && mode === 'canvas' && selectedIds.length) { event.preventDefault(); groupSelection(); }
    else if ((event.ctrlKey || event.metaKey) && key === 'a') { event.preventDefault(); fire(requestSelection(nodes.filter(node => !node.hidden).map(node => node.id))); }
    else if (plain && key === 'n') { event.preventDefault(); if (mode === 'canvas') createCard('note'); else createSceneOrEvent(); }
    else if (plain && key === 'f') { event.preventDefault(); fit(); }
    else if (plain && key === 'l' && !event.shiftKey) { event.preventDefault(); arrangeActions.find(action => !action.disabled)?.run(); }
    else if (plain && key === 'i' && selectedIds.length) { event.preventDefault(); summonForSelection(); }
    else if (event.key === 'Escape' && (menu || selectedIds.length)) { event.preventDefault(); if (menu) setMenu(null); else clearSelection(); }
  }}>
    <div className="board-body"><div className={`flow-container ${arranging ? 'board-arranging' : ''}`} ref={container}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={instance => { flow.current = instance; }} onNodesChange={nodesChange} onNodeClick={(_, node) => { select(node.id); setMenu(null); }} onPaneClick={event => { setMenu(null); if (event.detail === 2 && mode === 'canvas') createCard('note', undefined, flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }} onPaneContextMenu={event => { event.preventDefault(); const rect = container.current?.getBoundingClientRect(); if (rect && flow.current) setMenu({ point: flow.current.screenToFlowPosition({ x: event.clientX, y: event.clientY }), screen: { x: event.clientX, y: event.clientY }, left: Math.max(8, Math.min(event.clientX - rect.left, rect.width - 260)), top: Math.max(8, Math.min(event.clientY - rect.top, rect.height - 360)) }); }} onNodeContextMenu={(event, node) => { event.preventDefault(); const rect = container.current?.getBoundingClientRect(); if (!rect || !flow.current) return; if (!selectedIds.includes(node.id)) select(node.id); setMenu({ nodeId: node.id, point: flow.current.screenToFlowPosition({ x: event.clientX, y: event.clientY }), screen: { x: event.clientX, y: event.clientY }, left: Math.max(8, Math.min(event.clientX - rect.left, rect.width - 260)), top: Math.max(8, Math.min(event.clientY - rect.top, rect.height - 260)) }); }} onNodeDragStart={(_, node) => { select(node.id); beginGesture(); }} onNodeDrag={(_, _node, items) => dragMove(items)} onNodeDragStop={(_, _node, items) => { const adjusted = items.map(item => snapped.current.has(item.id) ? { ...item, position: snapped.current.get(item.id)! } : item); snapped.current.clear(); setGuides([]); dragStop(adjusted); }} nodesConnectable={mode !== 'story'} onConnect={mode === 'story' ? undefined : connect} onEdgesDelete={items => {
        if (mode === 'canvas') fire(commit(items.flatMap(edge => ((edge.data?.linkIds as string[] | undefined) ?? [edge.id]).map(id => ({ type: 'deleteCanvasLink' as const, id })))));
        else if (mode === 'world') fire(commit(current => items.flatMap(edge => { const value = current.objects.find(value => value.id === edge.target); return value?.event ? [{ type: 'putObject' as const, value: { ...value, event: { ...value.event, causes: value.event.causes.filter(id => id !== edge.source) } } }] : []; })));
      }} deleteKeyCode={null} selectionKeyCode="Shift" multiSelectionKeyCode="Control" zoomOnDoubleClick={mode !== 'canvas'} fitView fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }} minZoom={0.2} maxZoom={1.5} proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--canvas-dot)" /><Controls showInteractive={false} position="bottom-right" fitViewOptions={{ padding: 0.2, maxZoom: 1.1, duration: motionDuration(200) }} />
        <ViewportPortal>{guides.map(guide => <div key={`${guide.orientation}:${guide.position}`} className={`align-guide ${guide.orientation}`} aria-hidden="true"
          style={guide.orientation === 'vertical' ? { transform: `translate(${guide.position}px, ${guide.from - 12}px)`, height: guide.to - guide.from + 24 } : { transform: `translate(${guide.from - 12}px, ${guide.position}px)`, width: guide.to - guide.from + 24 }}/>)}</ViewportPortal>
        {minimap && <MiniMap pannable zoomable position="bottom-right" className="board-minimap" nodeColor={node => (node.data as BoardData).kind === 'group' ? 'var(--canvas-group)' : (node.data as BoardData).tint || 'var(--accent-soft-strong)'} nodeStrokeWidth={0} maskColor="var(--minimap-mask)" />}
      </ReactFlow>

      <div className="board-float top-left board-tools" role="toolbar" aria-label={`${mode === 'canvas' ? '画布' : '图'}工具`}>
        {mode === 'canvas' ? <>
          <button className="primary small" title="在视口中心添加便笺（N）" onClick={() => createCard('note')}><Plus aria-hidden="true" />添加便笺</button>
          <button className="small ghost" title="添加空白分组" onClick={() => createCard('group')}><Layers aria-hidden="true" />添加分组</button>
          <Popover label="添加素材引用" triggerClassName="small ghost" trigger={<><Link2 aria-hidden="true" />引用素材</>}>{close => <Combobox label="搜索小说素材或叙述场景" placeholder="搜索人物、事件、场景…" items={referenceItems} empty="没有匹配的素材" onPick={item => { addReference(item); close(); }} />}</Popover>
        </> : <button className="primary small" title={`添加${mode === 'world' ? '世界事件' : '场景'}（N）`} onClick={() => createSceneOrEvent()}><Plus aria-hidden="true" />添加{mode === 'world' ? '世界事件' : '场景'}</button>}
        <span className="toolbar-sep" aria-hidden="true" />
        <button className="icon-button small ghost" title="适应视图（F）" aria-label="适应视图" onClick={fit}><Scan aria-hidden="true" /></button>
        <button className={`icon-button small ghost ${minimap ? 'selected' : ''}`} title={minimap ? '隐藏小地图' : '显示小地图'} aria-label="小地图" aria-pressed={minimap} onClick={() => setMinimap(!minimap)}><MapIcon aria-hidden="true" /></button>
        <button className={`icon-button small ghost ${snap ? 'selected' : ''}`} title={snap ? '关闭吸附对齐' : '开启吸附对齐（网格与参考线）'} aria-label="吸附对齐" aria-pressed={snap} onClick={toggleSnap}><Magnet aria-hidden="true" /></button>
        <Popover label="自动整理" triggerClassName="small ghost" testId="board-arrange" trigger={<><LayoutGrid aria-hidden="true" />整理</>}>{close => <div className="menu-list arrange-menu" role="menu">
          <p className="menu-caption">自动整理{mode === 'canvas' ? '画布' : mode === 'world' ? '世界因果图' : '叙述顺序'}布局（L）。只调整位置，可在修改历史中撤销。</p>
          {arrangeActions.map(action => <button key={action.label} role="menuitem" className="rich" disabled={action.disabled} onClick={() => { close(); action.run(); }}><action.icon aria-hidden="true" /><span><strong>{action.label}</strong><small>{action.hint}</small></span></button>)}
        </div>}</Popover>
      </div>

      <div className="board-float top-right">
        {mode === 'canvas' && <Popover label="作品方向" className="canvas-direction" triggerClassName="small ghost" align="end" trigger={<><Compass aria-hidden="true" />作品方向</>}>
          <div className="direction-card"><span className="eyebrow">{w.title}</span><p>{w.brief || '记录故事的出发点，让画布灵感与作品方向一起演进。'}</p>{w.theme && <p className="direction-theme"><strong>立意</strong>{w.theme}</p>}<button className="small" data-testid="canvas-develop-theme" onClick={event => summon(below(event), [], w.theme?.trim() ? '在现有立意的基础上深化，给我几个不同侧重的版本。' : '根据我已有的信息和画布上的灵感推断几个立意方向；信息不够就先问我几个选择题。', '作品立意', 'develop', undefined, 'theme')}><Sparkles aria-hidden="true" />{w.theme?.trim() ? '深化作品立意' : '推断作品立意'}</button></div>
        </Popover>}
        <Popover label="AI 整理" triggerClassName="small ai-trigger" align="end" trigger={<><Sparkles aria-hidden="true" />AI 整理</>}>{close => <div className="menu-list" role="menu">
          <p className="menu-caption">针对整个{mode === 'canvas' ? '画布' : mode === 'world' ? '世界因果图' : '叙述顺序'}。选中{noun}后可只处理所选内容。</p>
          {boardActions.map(action => <button key={action.label} role="menuitem" disabled={action.disabled} onClick={event => { const screen = below(event); close(); action.run(screen); }}>{action.agent ? <Bot aria-hidden="true" /> : <Sparkles aria-hidden="true" />}{action.label}</button>)}
          <span className="menu-sep" aria-hidden="true" />
          <button role="menuitem" data-testid="board-agent-task" onClick={() => { close(); onPrepare('agent', sourceReferences(selectedIds)); }}><Bot aria-hidden="true" />交给智能体完成…</button>
        </div>}</Popover>
      </div>

      {legend.length > 0 && <div className="board-float bottom-left lane-legend" aria-label={mode === 'world' ? '情节支线' : '叙述视角'}>{legend.map((label, index) => <span key={`${label}-${index}`}><i style={{ background: colors[index % colors.length] }} />{label}</span>)}</div>}

      {selectedIds.length > 0 && <div className="board-selection-toolbar" role="toolbar" aria-label="选中内容操作">
        <span className="selection-count"><MousePointer2 aria-hidden="true" />已选 {selectedIds.length} 个{noun}</span>
        {mode === 'canvas' && <button className="small ghost" title="将选中卡片成组（Ctrl+G）" onClick={groupSelection}><Layers aria-hidden="true" />成组</button>}
        {mode === 'canvas' && availableGroups.length + w.cards.filter(value => selectedIds.includes(value.id) && value.groupId).length > 0 && <Popover label="将选中卡片移入分组" side="top" triggerClassName="small ghost" trigger={<>移入分组…</>}>{close => <Combobox label="选择目标分组" placeholder="搜索分组…" items={[{ id: '_none', label: '移出分组', group: '操作' }, ...availableGroups.map(value => ({ id: value.id, label: value.title, group: '分组' }))]} onPick={item => { if (item.id === '_none') assign([...selectedIds]); else assign([...selectedIds], item.id); close(); }} />}</Popover>}
        {selectedIds.length > 1 && <Popover label="对齐与分布" side="top" triggerClassName="small ghost" trigger={<><AlignStartVertical aria-hidden="true" />对齐</>}>{close => <div className="align-panel">
          <div className="align-grid" role="group" aria-label="对齐与分布">{alignActions.map(action => <button key={action.how} className="icon-button ghost" title={action.label} aria-label={action.label} disabled={selectedIds.length < action.min} onClick={() => { close(); alignSelection(action.how); }}><action.icon aria-hidden="true" /></button>)}</div>
          {mode === 'canvas' && <button className="small ghost align-tidy" onClick={() => { close(); tidyCanvas([...selectedIds]); }}><LayoutGrid aria-hidden="true" />整理所选</button>}
        </div>}</Popover>}
        <span className="toolbar-sep" aria-hidden="true" />
        <button className="small ai-trigger" data-testid="summon-companion" title="唤出创作伙伴（I）" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); summon({ x: rect.left, y: rect.top - 8 }, sourceReferences(selectedIds), undefined, selectedIds.length > 1 ? `已选 ${selectedIds.length} 个${noun}` : nodeTitle(selectedIds[0]!)); }}><Sparkles aria-hidden="true" />{mode === 'canvas' ? '发散' : mode === 'world' ? '推演因果' : '诊断结构'}</button>
        {mode === 'canvas' && <button className="small ghost ai-action" data-testid="selection-develop-cast" onClick={event => summon(above(event), sourceReferences(selectedIds), '这些灵感牵涉到哪些人物？补充需要的人物，并和相关卡片连起来。', '补人物', 'develop', undefined, 'cast')}><UserRound aria-hidden="true" />补人物</button>}
        {mode === 'canvas' && selectedIds.length > 1 && <button className="small ghost ai-action" data-testid="selection-link" onClick={event => summon(above(event), sourceReferences(selectedIds), linkMessage, `连线 · 已选 ${selectedIds.length} 张`)}><Link2 aria-hidden="true" />自动连线</button>}
        {mode === 'world' && <button className="small ghost ai-action" onClick={event => summon(above(event), sourceReferences(selectedIds), `「${nodeTitle(selectedIds[0]!)}」背后还缺什么前因？给我几个可能的起点。`, '补前因')}><Sparkles aria-hidden="true" />补前因</button>}
        {(hasSelectedGroup || mode === 'world') && <button className="small ghost ai-action" onClick={event => summon(above(event), sourceReferences(selectedIds), mode === 'world' ? '根据选中的世界事件，安排读者看到的章节与场景。' : '根据选中分组里的素材展开大纲。', '展开大纲', 'outline')}>{mode === 'world' ? '据此展开场景' : '据分组展开大纲'}</button>}
        {selectedStoryScene && <button className="small ghost ai-action" disabled={!!selectedStoryScene.text.trim()} title={selectedStoryScene.text.trim() ? '已有正文，请进入写作选择文字改写' : '根据当前场景大纲生成正文'} onClick={() => onPrepare('chapter', [{ kind: 'scene', id: selectedStoryScene.id }])}>生成当前场景</button>}
        <button className="small ghost ai-action" data-testid="selection-agent-task" title="多步骤目标：交给编排智能体完成，修改经你批准后写入" onClick={() => onPrepare('agent', sourceReferences(selectedIds))}><Bot aria-hidden="true" />交给智能体…</button>
        <span className="toolbar-sep" aria-hidden="true" />
        <button className="small ghost-danger" title="删除选中内容（Delete）" onClick={deleteSelection}><Trash2 aria-hidden="true" />删除选中内容</button>
        <button className="icon-button small ghost" aria-label="取消选择" title="取消选择（Esc）" onClick={clearSelection}><X aria-hidden="true" /></button>
      </div>}

      {!nodes.length && <div className="board-empty"><div className="empty-mark">{mode === 'canvas' ? <StickyNote aria-hidden="true" /> : mode === 'world' ? <Milestone aria-hidden="true" /> : <Film aria-hidden="true" />}</div><h3>{mode === 'canvas' ? '把第一个想法放到画布上' : mode === 'world' ? '从故事里发生的第一件事开始' : '先安排读者看到的第一幕'}</h3><p>{mode === 'canvas' ? '双击空白处或按 N 添加便笺，再通过分组和连线整理。' : mode === 'world' ? '添加世界事件，从原因拖向结果建立因果。' : '添加场景与大纲，然后进入正文写作。'}</p></div>}

      <Popover label="画布快捷键" className="board-float bottom-left-help" side="top" triggerClassName="icon-button small ghost board-help" trigger={<CircleHelp aria-hidden="true" />}>
        <div className="shortcut-list"><strong>{mode === 'canvas' ? '灵感画布' : mode === 'world' ? '世界因果' : '叙述顺序'}</strong><p className="muted">{mode === 'canvas' ? '连线表示素材关联；把卡片中心拖入分组即可归组。' : mode === 'world' ? '从原因连向结果建立真实因果；拖动只调整布局。' : '连线展示阅读顺序；拖动只调整布局，章节与顺序在写作目录中修改。'}</p><dl>{shortcuts.map(([key, text]) => <div key={key}><dt><Kbd>{key}</Kbd></dt><dd>{text}</dd></div>)}</dl></div>
      </Popover>

      {shownMenu && <div className="board-create-menu" data-state={menu ? 'open' : 'closed'} inert={!menu} style={{ left: shownMenu.left, top: shownMenu.top }} role="menu" aria-label={shownMenu.nodeId ? '创作伙伴' : '在此处添加'} data-testid="board-context-menu" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); return; }
        if (!['ArrowDown', 'ArrowUp'].includes(event.key) || (event.target as HTMLElement).closest('input')) return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button')], index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}>
        {shownMenu.nodeId ? <>
          <span className="menu-caption"><Sparkles aria-hidden="true" />创作伙伴 · {nodeTitle(shownMenu.nodeId)}</span>
          {nodePrompts(shownMenu.nodeId).map((prompt, index) => <button key={prompt.label} role="menuitem" autoFocus={index === 0} data-testid="companion-menu-item" onClick={() => summon(shownMenu.screen, sourceReferences(selectedIds.includes(shownMenu.nodeId!) ? selectedIds : [shownMenu.nodeId!]), prompt.message, `${prompt.label} · ${nodeTitle(shownMenu.nodeId!)}`, prompt.kind, undefined, prompt.focus)}>
            {prompt.label.includes('追问') ? <MessageCircleQuestion aria-hidden="true" /> : <Sparkles aria-hidden="true" />}{prompt.label}</button>)}
          <button role="menuitem" onClick={() => summon(shownMenu.screen, sourceReferences([shownMenu.nodeId!]), undefined, nodeTitle(shownMenu.nodeId!))}>自己说…</button>
        </> : <>
        {panePrompts.map(prompt => <button key={prompt.label} role="menuitem" data-testid="companion-menu-item" onClick={() => summon(shownMenu.screen, [], prompt.message, prompt.label, companionMode, mode === 'canvas' ? shownMenu.point : undefined)}>{prompt.label.includes('追问') ? <MessageCircleQuestion aria-hidden="true" /> : <Sparkles aria-hidden="true" />}{prompt.label}</button>)}
        <span className="menu-sep" aria-hidden="true" />
        {mode === 'canvas' ? <>
          <button role="menuitem" autoFocus onClick={() => createCard('note', undefined, shownMenu.point)}><StickyNote aria-hidden="true" />添加便笺</button>
          <button role="menuitem" onClick={() => createCard('group', undefined, shownMenu.point)}><Layers aria-hidden="true" />添加分组</button>
          <div className="menu-combobox"><span className="menu-caption">在此引用素材或场景</span><Combobox label="在此添加素材引用" placeholder="搜索…" items={referenceItems} onPick={item => addReference(item, shownMenu.point)} /></div>
        </> : <button role="menuitem" autoFocus onClick={() => createSceneOrEvent(shownMenu.point)}><Plus aria-hidden="true" />添加{mode === 'world' ? '世界事件' : '场景'}</button>}
        </>}
      </div>}
    </div>
    </div>
    {showInspector && inspectorHost && createPortal(<aside className="board-inspector">{mode === 'canvas' && card ? <>
      <div className="section-heading inspector-head"><div><span className="eyebrow">{kindMeta[card.kind]?.label}</span><h3>{card.kind === 'group' ? '分组详情' : '卡片详情'}</h3></div><button className="icon-button small text-danger" title="删除卡片" aria-label="删除卡片" onClick={() => fire(askDelete({ type: 'deleteCard', id: card.id }, `删除卡片「${cardTitle(card)}」`))}><Trash2 aria-hidden="true" /></button></div>
      <div className="reference-actions">{card.refId && (card.kind === 'object' || card.kind === 'scene') && <button className="small primary" onClick={() => onOpenReference(card.kind as 'object' | 'scene', card.refId!)}>{card.kind === 'scene' ? '进入正文写作' : '打开素材'}<ArrowRight aria-hidden="true" /></button>}<button className="small" onClick={event => summon(below(event), [{ kind: 'card', id: card.id }], `围绕「${cardTitle(card)}」发散，把它发展成可以写的人物、事件或场景。`, cardTitle(card))}><Sparkles aria-hidden="true" />{card.kind === 'group' ? '发散分组素材' : '发展这条灵感'}</button>{card.kind === 'group' && <button className="small" onClick={event => summon(below(event), [{ kind: 'card', id: card.id }], '根据这个分组里的素材展开大纲。', '展开大纲', 'outline')}>据分组展开大纲</button>}</div>
      {referenceObject ? renderObjectForm(referenceObject) : referenceScene ? renderSceneForm(referenceScene) : <Field key={`${card.id}-title`} label="标题" value={card.title} onSave={title => patchCard(card.id, { title })} />}
      <Field key={`${card.id}-content`} label={card.refId ? '卡片备注' : '灵感与备注'} multiline value={card.content} onSave={content => patchCard(card.id, { content })} />
      <Select label="所属分组" value={card.groupId || ''} onChange={id => assign([card.id], id || undefined)}><option value="">不分组</option>{w.cards.filter(value => value.kind === 'group' && value.id !== card.id && !isDescendant(w.cards, value.id, card.id)).map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</Select>
      {card.kind === 'group' && <div className="subsection"><h3>分组成员 · {w.cards.filter(value => isDescendant(w.cards, value.id, card.id)).length}</h3><div className="button-row"><button className="small" onClick={() => fire(patchCard(card.id, { collapsed: !card.collapsed }))}>{card.collapsed ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}{card.collapsed ? '展开分组' : '折叠分组'}</button><button className="small" onClick={() => dissolve(card.id)}><Unlink aria-hidden="true" />解散并保留成员</button></div><div className="board-selection-list">{w.cards.filter(value => value.groupId === card.id).map(value => <button key={value.id} onClick={() => { if (card.collapsed) fire(patchCard(card.id, { collapsed: false }).then(() => requestSelection([value.id]))); else requestSelection([value.id]); }}>{(() => { const Icon = (kindMeta[value.kind] ?? kindMeta.note).icon; return <Icon aria-hidden="true" />; })()}{cardTitle(value)}</button>)}</div></div>}
      {(relatedEvents.length > 0 || relatedScenes.length > 0) && <div className="subsection"><h3>关联的世界与叙述</h3><div className="board-selection-list">{relatedEvents.map(value => <button key={`event:${value.id}`} onClick={() => onOpenReference('object', value.id)}><Milestone aria-hidden="true" />#{value.event!.worldOrder} · {value.name}</button>)}{relatedScenes.map(value => <button key={`scene:${value.id}`} onClick={() => onOpenReference('scene', value.id)}><Film aria-hidden="true" />{value.title}</button>)}</div></div>}
      {card.kind === 'note' && <div className="subsection"><h3>将便笺转为创作内容</h3><div className="convert-row"><select aria-label="便笺转换为小说素材" value="" onChange={event => convertNote(event.target.value)}><option value="">转换为素材类型…</option>{w.objectTypes.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select><button className="small" onClick={() => convertNote()}>转换为叙述场景</button></div></div>}
      <div className="subsection"><h3>关联素材</h3>{w.canvasLinks.filter(link => link.source === card.id || link.target === card.id || (card.kind === 'group' && (isDescendant(w.cards, link.source, card.id) || isDescendant(w.cards, link.target, card.id)))).map(link => { const linkedCard = w.cards.find(value => value.id === (link.source === card.id || isDescendant(w.cards, link.source, card.id) ? link.target : link.source)); return <div className="linked-row" key={link.id}><span>{linkedCard && cardTitle(linkedCard)}</span><button className="small ghost" aria-label="移除素材关联" onClick={() => fire(commit([{ type: 'deleteCanvasLink', id: link.id }]))}><Unlink aria-hidden="true" />移除关联</button></div>; })}{!w.canvasLinks.some(link => link.source === card.id || link.target === card.id) && card.kind !== 'group' && <p className="muted">从卡片底部的圆点拖到另一张卡片即可建立关联。</p>}</div>
    </> : mode === 'world' && object?.event ? <><div className="section-heading inspector-head"><div><span className="eyebrow">世界事件 · #{object.event.worldOrder}</span><h3>事件详情</h3></div><button className="icon-button small text-danger" title="删除事件" aria-label="删除事件" onClick={() => fire(askDelete({ type: 'deleteObject', id: object.id }, `删除世界事件「${object.name}」`))}><Trash2 aria-hidden="true" /></button></div><div className="reference-actions"><button className="small" onClick={event => summon(below(event), [{ kind: 'object', id: object.id }], `「${object.name}」之前缺什么前因、之后会引发什么？`, object.name)}><Sparkles aria-hidden="true" />推演事件因果</button><button className="small" onClick={event => summon(below(event), [{ kind: 'object', id: object.id }], `根据「${object.name}」安排读者看到的场景。`, '展开场景', 'outline')}>据此展开场景</button><button className="small ghost" onClick={() => onOpenCanvas('object', object.id)}>{canvasLabel('object', object.id)}<ArrowRight aria-hidden="true" /></button></div>{renderObjectForm(object)}</>
    : mode === 'story' && scene ? <><div className="section-heading inspector-head"><div><span className="eyebrow">叙述场景</span><h3>场景详情</h3></div><button className="icon-button small text-danger" title="删除场景" aria-label="删除场景" onClick={() => fire(askDelete({ type: 'deleteScene', id: scene.id }, `删除场景「${scene.title}」`))}><Trash2 aria-hidden="true" /></button></div><div className="reference-actions"><button className="small primary" onClick={() => onOpenReference('scene', scene.id)}>进入正文写作<ArrowRight aria-hidden="true" /></button><button className="small" onClick={event => { setMenu(null); const rect = event.currentTarget.getBoundingClientRect(); companion.summon({ mode: 'outline', anchor: { surface: 'outline', references: [{ kind: 'scene', id: scene.id }], outlineNode: { kind: 'scene', id: scene.id } }, screen: { x: rect.left, y: rect.bottom }, message: `完善「${scene.title}」的场景大纲：这一场发生什么、谁的视角、结束时有什么变化。`, label: scene.title }); }}><Sparkles aria-hidden="true" />完善场景大纲</button><button className="small" disabled={!!scene.text.trim()} title={scene.text.trim() ? '已有正文，请进入写作选择文字改写' : '根据场景大纲生成正文'} onClick={() => onPrepare('chapter', [{ kind: 'scene', id: scene.id }])}>生成当前场景</button><button className="small ghost" onClick={() => onOpenCanvas('scene', scene.id)}>{canvasLabel('scene', scene.id)}<ArrowRight aria-hidden="true" /></button></div>{renderSceneForm(scene)}</>
    : <div className="inspector-empty"><Network aria-hidden="true" /><p>选择一个{noun}<br />查看与编辑详情</p></div>}</aside>, inspectorHost)}
  </div>;
}
