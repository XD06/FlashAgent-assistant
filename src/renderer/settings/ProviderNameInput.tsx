import React from 'react'
import { SettingInput } from './SettingInput'

type ProviderNameInputProps = {
  readonly value: string
  readonly placeholder: string
  readonly onChange: (value: string) => void
}

export function ProviderNameInput({
  value,
  placeholder,
  onChange
}: ProviderNameInputProps) {
  return (
    <SettingInput
      className="provider-name"
      value={value}
      placeholder={placeholder}
      onChange={onChange}
    />
  )
}
