import React from 'react'
import { Box, Text } from 'ink'
import { actionMenuLabel } from './action-menu.ts'
import { display, type MenuState } from './ui-model.ts'
import { terminalWidth } from './ui-actions.ts'

/** 统一绘制可滚动的动作弹窗，页面只负责提供菜单状态和执行动作。 */
export function ActionMenuView({ menu, columns, rows }: { menu: MenuState; columns: number; rows: number }): React.ReactElement {
  const maxLabelWidth = Math.max(0, ...menu.items.map((item) => terminalWidth(actionMenuLabel(item))))
  const width = Math.max(8, Math.min(Math.max(32, maxLabelWidth + 6), Math.max(8, columns - 4)))
  const contentTop = 1
  const contentHeight = Math.max(1, rows - contentTop - 2)
  const height = Math.min(contentHeight, menu.items.length + 3)
  const top = contentTop + Math.max(0, Math.floor((contentHeight - height) / 2))
  const left = Math.max(0, Math.floor((columns - width) / 2))
  return <Box position="absolute" top={top} left={left} width={width} height={height} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} backgroundColor="black" overflow="hidden">
    <Text bold color="cyan">操作</Text>
    {menu.items.map((item, index) => <Text key={item.action} wrap="truncate-end" color={index === menu.index ? 'yellow' : item.enabled ? 'white' : 'gray'}>{index === menu.index ? '> ' : '  '}{display(actionMenuLabel(item))}</Text>)}
  </Box>
}
