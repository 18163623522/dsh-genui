import type { GenuiNode, GenuiSpec } from './spec.ts'

/** 遍历完整 GenUI 组件树，并提供每个组件在 spec 中的路径。 */
export function walkGenuiNodes(spec: GenuiSpec, visitor: (node: GenuiNode, path: string) => void): void {
  const walk = (nodes: GenuiNode[], path: string): void => {
    nodes.forEach((node, index) => visit(node, `${path}[${index}]`))
  }
  const visit = (node: GenuiNode, at: string): void => {
    visitor(node, at)
    switch (node.type) {
      case 'row':
      case 'col':
      case 'grid':
      case 'card':
        walk(node.items, `${at}.items`)
        break
      case 'tabs':
        node.tabs.forEach((tab, tabIndex) => walk(tab.items, `${at}.tabs[${tabIndex}].items`))
        break
      case 'accordion':
        node.items.forEach((item, itemIndex) => walk(item.items, `${at}.items[${itemIndex}].items`))
        break
      case 'list':
        node.items.forEach((item, itemIndex) => {
          if (item !== null && typeof item === 'object' && 'type' in item) visit(item, `${at}.items[${itemIndex}]`)
        })
        break
    }
  }
  walk(spec.items, 'items')
}
