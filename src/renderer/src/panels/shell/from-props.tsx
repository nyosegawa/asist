import type { CardDefinition } from './card'

/** Wraps a body that only needs the props into the shell's Body shape, which takes a spec and a size. */
export const fromProps = <P,>(Component: React.FC<{ props: P }>): CardDefinition['Body'] =>
  function PropsCard({ spec }) {
    return <Component props={spec.props as P} />
  }
