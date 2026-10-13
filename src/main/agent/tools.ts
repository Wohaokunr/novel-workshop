import { objectSchema, type AgentTool, type JsonSchema, type ToolCallContext } from '../responses.js';
import { PLAN_ROLES } from './policy.js';

const string: JsonSchema = { type: 'string' };
const strings: JsonSchema = { type: 'array', items: string };
const nullable: JsonSchema = { type: ['string', 'null'] };
const node = objectSchema({
  id: string, role: { type: 'string', enum: PLAN_ROLES },
  objective: string, dependsOn: strings, acceptance: string,
  passageId: nullable, sceneId: nullable, chapterId: nullable, characterId: nullable, eventId: nullable,
});
export const toolDefinitions = [
  { name: 'read_project', description: '读取当前作品的有界概览、实体目录及本次目标范围；需要完整原文时使用 read_entities 或 get_context。', parameters: objectSchema({}) },
  { name: 'read_entities', description: '按类型与 ID 读取正式作品或当前候选的真实内容，不把卡片备注当作引用实体。passages 是场景段（场景在某一章里的正文），长正文只返回首尾，完整窗口用 read_text；stateChanges 是人物与环境的状态变化。', parameters: objectSchema({ kind: { type: 'string', enum: ['objects', 'acts', 'chapters', 'scenes', 'passages', 'facts', 'knowledge', 'stateChanges', 'cards'] }, ids: strings, candidateId: nullable }) },
  { name: 'search_context', description: '检索这部作品的相关原文片段（每个场景段最多两段），返回可核对的来源和内容 hash。可按章节 ID 范围或对象 ID（人物/物件/事件出现或变化的场景段）缩小范围。', parameters: objectSchema({ query: string, chapterFrom: nullable, chapterTo: nullable, entityId: nullable }) },
  { name: 'read_story_memory', description: '读取故事记忆（由正文生成的辅助摘要，不是正式事实）：给章节 ID 范围时返回这些章的章摘要与场景段摘要；给对象 ID 时返回其出场时间线、每次出场的摘要，以及作者记下的状态变化。用于在全书梗概与原文之间逐层放大。', parameters: objectSchema({ chapterFrom: nullable, chapterTo: nullable, entityId: nullable }) },
  { name: 'read_text', description: '读取一个场景段正文的指定窗口（最多 6000 字），用于核对摘要或检索片段的上下文。', parameters: objectSchema({ passageId: string, start: { type: 'integer' }, length: { type: 'integer' } }) },
  { name: 'get_context', description: '装配一个场景段的写作上下文，包括所属场景、人物与环境此刻的状态、人物知识边界和前文。', parameters: objectSchema({ passageId: string, candidateId: nullable }) },
  { name: 'recall_memory', description: '读取作者确认的偏好/约束及有来源的任务经验；记忆不是正式小说事实。', parameters: objectSchema({}) },
  { name: 'refresh_context', description: '人工修改使旧候选过期时，重新读取作品基线并作新计划；旧候选保留但不可继续批准。', parameters: objectSchema({}) },
  { name: 'set_plan', description: '保存真正可执行的专长任务及依赖。保存后运行时自动按依赖执行节点、把带修改的产物组成候选、审查正文并提交作者批准，完成或需要你决定时交还给你。节点状态由实际执行推进，不接受自称已完成；重新规划时，目标、范围与依赖未变的已完成节点保留结果。仅在目标需要这些专长时设置，不必固定调用所有角色；构思类目标不超过 6 个节点。writer 用 passageId 指定要写的场景段；evolution 用 sceneId（场景跨章时加 passageId）记下这一场人物与环境的状态变化，characterId 可只看一个人物；character 需要 characterId 与 eventId。cast=人物塑造（新建/丰富人物并在画布连线）。', parameters: objectSchema({ summary: string, nodes: { type: 'array', items: node } }) },
  { name: 'delegate_tasks', description: '立即执行已保存计划中依赖满足的节点（最多两个并行）。通常不需要：运行时会自动执行计划。子任务返回结论和修改条数，绝不直接改正式作品。', parameters: objectSchema({ nodeIds: strings }) },
  { name: 'save_report', description: '保存分析或回答作为本次实际产物。纯分析目标不必生成修改。', parameters: objectSchema({ label: string, text: string }) },
  { name: 'propose_changes', description: '把子任务产物中的命令、commandsJson(JSON命令数组，可为空字符串)和 opsJson(故事操作数组，可为空字符串)组装为累计候选工作区。画布卡片、连线、人物、事件因果、大纲优先用 opsJson，程序自动处理位置与引用。只预览，不改正式作品；组成后运行时会按需审查并提交作者批准。', parameters: objectSchema({ label: string, artifactIds: strings, commandsJson: string, opsJson: string }) },
  { name: 'read_candidate', description: '检查候选修改及工作区，后续写作/检查可以使用候选版本。', parameters: objectSchema({ candidateId: string }) },
  { name: 'revise_candidate', description: '按候选审查意见重新执行指定计划节点，读取当前候选原文与审查意见并形成新候选。用于修订，不要重复委派已完成节点取回旧产物。修订后需要重新 review_candidate。', parameters: objectSchema({ candidateId: string, nodeIds: strings, objective: string }) },
  { name: 'review_candidate', description: '通常由运行时自动调用。独立审查修改了正文的候选；有修改意见时自动让写作者修订并重新审查，直到通过或达到修订上限。返回最终候选 candidateId/candidateHash。', parameters: objectSchema({ candidateId: string }) },
  { name: 'commit_candidate', description: '通常由运行时自动调用。把候选提交作者一键批准：修改正文的候选须先审查；只改设定、画布、人物、大纲的候选可直接提交。执行将挂起等待批准，未批准不算保存；拒绝后应尊重作者，不绕过审批。', parameters: objectSchema({ candidateId: string, candidateHash: string }) },
  { name: 'ask_author', description: '缺少作者必须决定的信息时提出一个具体问题，持久等待回答。options 给 2–4 个可直接点选的具体答案（无法预设时给 []）。不要询问可以由现有资料或常规默认决定的问题。', parameters: objectSchema({ question: string, options: strings }) },
  { name: 'suggest_memory', description: '提出可供作者确认的偏好/约束记忆，不能把自己的建议自动变成作者偏好。', parameters: objectSchema({ content: string, kind: { type: 'string', enum: ['preference', 'constraint'] } }) },
  { name: 'finish_run', description: '根据真实产物提交最终总结。计划还有可执行节点或候选正等待作者决定时不能结束；失败的节点与未提交的修改由运行时记录在总结之后，总结里也要如实说明。', parameters: objectSchema({ summary: string, artifactIds: strings }) },
] as const;
export type ToolName = typeof toolDefinitions[number]['name'];
export function createCoordinatorTools(execute: (name: ToolName, args: Record<string, unknown>, signal: AbortSignal, call?: ToolCallContext) => Promise<unknown>): AgentTool[] {
  return toolDefinitions.map(tool => ({ ...tool, execute: (args, signal, call) => execute(tool.name, args, signal, call) }));
}
