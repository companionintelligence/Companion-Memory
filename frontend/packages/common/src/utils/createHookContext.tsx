import { createContext, useContext, type ReactNode } from 'react';

// We need the `any` here, we're knowingly setting this and ignoring the
// ESLint rule. Please do not accept this as a more broadly applicable pattern.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createHookContext<HookArgs extends any[], HookResult>(
  hook: (...args: HookArgs) => HookResult,
  name?: string,
) {
  const Context = createContext<HookResult | undefined>(undefined);

  function Provider({ children, args }: { children: ReactNode; args: HookArgs }) {
    const value = hook(...args);

    return <Context.Provider value={value}>{children}</Context.Provider>;
  }

  function useHookContext() {
    const ctx = useContext(Context);

    if (!ctx) {
      throw new Error(`${name} must be used within the associated Provider`);
    }

    return ctx;
  }

  return {
    Provider,
    useHookContext,
  };
}
