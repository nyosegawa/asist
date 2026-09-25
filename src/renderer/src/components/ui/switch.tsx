import * as SwitchPrimitive from '@radix-ui/react-switch'

export function HoloSwitch({
  checked,
  onCheckedChange,
  disabled,
  'aria-label': ariaLabel
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  'aria-label'?: string
}): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className="relative h-5 w-9 cursor-pointer rounded-full border border-holo-line bg-holo-bg/70 transition-colors data-[state=checked]:border-holo-cyan/60 data-[state=checked]:bg-holo-cyan/25"
    >
      <SwitchPrimitive.Thumb className="block h-3.5 w-3.5 translate-x-0.5 rounded-full bg-holo-dim transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-holo-cyan data-[state=checked]:shadow-[0_0_8px_color-mix(in_srgb,var(--color-holo-cyan)_calc(70%*var(--ui-glow-strength)),transparent)]" />
    </SwitchPrimitive.Root>
  )
}
