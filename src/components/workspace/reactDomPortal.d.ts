// 项目没装 @types/react-dom；右键菜单（ContextMenu.tsx）用 createPortal、换风格的转场（motion.tsx）用 flushSync，这里补上它们的类型。
declare module "react-dom" {
  import type { ReactNode, ReactPortal } from "react";
  export function createPortal(children: ReactNode, container: Element | DocumentFragment, key?: string | null): ReactPortal;
  export function flushSync<R>(fn: () => R): R;
}
