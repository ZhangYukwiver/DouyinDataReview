// 项目没装 @types/react-dom；看板的右键菜单（AiEditMenu.tsx）只用到 createPortal，这里补上它的类型。
declare module "react-dom" {
  import type { ReactNode, ReactPortal } from "react";
  export function createPortal(children: ReactNode, container: Element | DocumentFragment, key?: string | null): ReactPortal;
}
