import {
  CircleHelp,
  Copy,
  FlaskConical,
  Languages,
  Laptop,
  Moon,
  Pin,
  PinOff,
  ScanText,
  Search,
  Sparkles,
  Square,
  Sun,
  Trash2,
  X,
  type LucideIcon
} from 'lucide-react'

const icons: Record<string, LucideIcon> = {
  'circle-help': CircleHelp,
  copy: Copy,
  'flask-conical': FlaskConical,
  languages: Languages,
  laptop: Laptop,
  moon: Moon,
  pin: Pin,
  'pin-off': PinOff,
  'scan-text': ScanText,
  search: Search,
  sparkles: Sparkles,
  square: Square,
  sun: Sun,
  'trash-2': Trash2,
  x: X
}

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const Component = icons[name] ?? Sparkles
  return <Component size={size} strokeWidth={2} />
}
