// WinRT OCR inserts a space between adjacent CJK glyphs ("关 于 我"), while
// PP-OCR does not. Collapsing those spaces is the single biggest readability
// win from the WinRT trial (see docs/ocr-winrt-test-result.md). Only spaces with
// CJK on BOTH sides are removed — Latin/CJK word boundaries keep theirs.

// CJK radicals through Unified Ideographs, Hangul, CJK compatibility
// ideographs, and fullwidth forms (covers CJK punctuation like ，、。
const CJK_CLASS = '\\u2e80-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef'
const CJK_SPACE = new RegExp(`([${CJK_CLASS}])[ \\t]+(?=[${CJK_CLASS}])`, 'g')

export function cleanupOcrSpaces(text: string): string {
  return text.replace(CJK_SPACE, '$1')
}
