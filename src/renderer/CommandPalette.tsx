import { Combobox, Dialog, type ComboItem } from './ui';

export interface PaletteCommand extends ComboItem { run: () => void }

export default function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  return <Dialog title="搜索与跳转" onClose={onClose}>
    <div className="command-palette">
      <Combobox label="搜索页面、场景、人物或操作" placeholder="输入页面、场景、人物或 AI 工具…" items={commands} empty="没有匹配的页面、内容或操作"
        onPick={item => { onClose(); requestAnimationFrame(() => commands.find(command => command.id === item.id)?.run()); }}/>
      <p className="palette-hint">↑↓ 选择 · Enter 打开 · Esc 关闭</p>
    </div>
  </Dialog>;
}
