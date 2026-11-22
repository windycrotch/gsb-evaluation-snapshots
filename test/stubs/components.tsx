import type { ReactNode } from 'react';

interface TextStubProps {
  children?: ReactNode;
  color?: string;
  inline?: boolean;
  bold?: boolean;
  className?: string;
}

// 轻量 Text 桩：保留全部 props 类型并透传，渲染为 span 以便断言日志内容
export function Text(props: TextStubProps) {
  const { children, inline, ...rest } = props;
  return inline ? (
    <span {...rest}>{children}</span>
  ) : (
    <div {...rest}>
      <span>{children}</span>
    </div>
  );
}

// Toast 桩：show 为可断言的 spy，测试里通过 JXToast.show 检查提示
export const toastShow = vi.fn();

export function JXToast() {
  return {
    show: toastShow,
    loading: toastShow,
    close: vi.fn(),
    closeAll: vi.fn()
  };
}
