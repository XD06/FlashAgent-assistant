import React from 'react'

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
  const [text, setText] = React.useState(value)
  const composingRef = React.useRef(false)

  React.useEffect(() => {
    if (!composingRef.current) setText(value)
  }, [value])

  return (
    <input
      className="provider-name"
      value={text}
      placeholder={placeholder}
      onCompositionStart={() => {
        composingRef.current = true
      }}
      onCompositionEnd={(event) => {
        composingRef.current = false
        setText(event.currentTarget.value)
        onChange(event.currentTarget.value)
      }}
      onChange={(event) => {
        setText(event.target.value)
        if (!composingRef.current) onChange(event.target.value)
      }}
    />
  )
}
