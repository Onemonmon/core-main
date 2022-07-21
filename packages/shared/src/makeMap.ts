// const example = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)
// makeMap(example) => { __proto__: true, __v_isRef: true, __isVue: true }
// 最终返回一个函数，判断该值是否存在
export function makeMap(
  str: string,
  expectsLowerCase?: boolean
): (key: string) => boolean {
  const map: Record<string, boolean> = Object.create(null)
  const list: Array<string> = str.split(',')
  for (let i = 0; i < list.length; i++) {
    map[list[i]] = true
  }
  return expectsLowerCase ? val => !!map[val.toLowerCase()] : val => !!map[val]
}
