function ordinal(value){
  if(/^\d+$/.test(value))return Number(value)
  const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9},units={十:10,百:100,千:1000,万:10000}
  let total=0,section=0,n=0
  for(const c of value){if(Object.hasOwn(digits,c))n=digits[c];else if(c==='万'){total+=(section+n||1)*10000;section=0;n=0}else if(units[c]){section+=(n||1)*units[c];n=0}else return null}
  return total+section+n
}
/** Display-only: retain an original heading if its number differs from the target episode. */
export function episodeDisplayTitle(value,number){
  const title=String(value||'').trim()
  const match=/^(?:第\s*([零〇一二两三四五六七八九十百千万0-9]+)\s*集|EP(?:ISODE)?\.?\s*(\d+))(?:\s*[|｜·:：\-—]\s*|\s+|$)/iu.exec(title)
  return match&&ordinal(match[1]||match[2])===Number(number)?title.slice(match[0].length).trim():title
}
