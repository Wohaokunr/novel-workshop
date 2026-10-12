import type { Command, SourceReference, AssistTool, Workspace } from '../shared/types';

export type View = 'home' | 'objects' | 'canvas' | 'outline' | 'world' | 'story' | 'write' | 'reader' | 'monitor' | 'settings' | 'style';
export type AskAction = (title:string, message:string, action:()=>Promise<Workspace>)=>Promise<Workspace>;
export type RegisterFlush = (flush: (() => Promise<void>) | null) => void;
export type AssistAction = (tool: AssistTool, references: SourceReference[]) => void;
export type OpenCanvas = (kind: 'object' | 'scene', id: string) => void;
export type AskDelete = (commands: Command | Command[], title: string) => Promise<unknown>;
export const canvasAction = (w: Workspace, kind: 'object' | 'scene', id: string) => w.cards.some(card => card.kind === kind && card.refId === id) ? '在画布定位' : '添加到画布';
export type SaveState = 'editing' | 'saving' | 'error' | 'conflict';
