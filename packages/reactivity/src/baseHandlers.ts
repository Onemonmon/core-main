import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  isReadonly,
  isShallow
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'

// /*#__PURE__*/ 可以使用rollup的tree-shaking

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*#__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

const get = /*#__PURE__*/ createGetter()
const shallowGet = /*#__PURE__*/ createGetter(false, true)
const readonlyGet = /*#__PURE__*/ createGetter(true)
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

/**
 * 扩展数组的一些方法，使其可以进行依赖收集
 */
const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()
function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // 对includes indexOf lastIndexOf的扩展
  // 1.会对数组下标进行依赖收集
  // 2.当返回的结果不正确时，会尝试toRaw获取数组的每一项原数据，再次调用方法
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 获取原数组
      const arr = toRaw(this) as any
      // 1.
      for (let i = 0, l = this.length; i < l; i++) {
        track(arr, TrackOpTypes.GET, i + '')
      }
      // 调用数组原来的方法得到结果
      const res = arr[key](...args)
      // 2.
      if (res === -1 || res === false) {
        /**
          const obj = { name: 1 }
          const arr = reactive([obj])
          const state = reactive(obj)
          arr.includes(obj) => true
          arr.includes(state) => true
         */
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // 一些影响数组长度的方法会暂停依赖收集
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      pauseTracking()
      const res = (toRaw(this) as any)[key].apply(this, args)
      resetTracking()
      return res
    }
  })
  return instrumentations
}

// getter工厂函数
function createGetter(isReadonly = false, shallow = false) {
  return function get(target: Target, key: string | symbol, receiver: object) {
    console.log('getter ', target, key)

    // isReactive函数判断对象是否是响应式，会进来这里
    if (key === ReactiveFlags.IS_REACTIVE) {
      // isReadonly=true只读，则不是响应式
      return !isReadonly
    }
    // isReadonly函数判断对象是否只读，会进来这里
    else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    }
    // isShallow函数判断对象是否是浅响应式，会进来这里
    else if (key === ReactiveFlags.IS_SHALLOW) {
      return shallow
    }
    // toRaw函数返回原对象，会进来这里
    else if (
      key === ReactiveFlags.RAW &&
      // 这个判断暂时不知道干嘛 ？？？
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
          ? shallowReactiveMap
          : reactiveMap
        ).get(target)
    ) {
      return target
    }
    // 代理的是数组时，访问数组的一些方法时，需要劫持，进行依赖收集
    const targetIsArray = isArray(target)
    // 访问数组的方法时
    if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
      return Reflect.get(arrayInstrumentations, key, receiver)
    }
    const res = Reflect.get(target, key, receiver)
    // 访问的是不可收集依赖的属性：Symbol内置属性、__proto__,__v_isRef,__isVue
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }
    // 不是只读，追踪收集依赖
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }
    // shallow函数不再进行子对象的代理
    if (shallow) {
      return res
    }
    // 访问的值是个ref
    // 1.通过对象的属性获取 => 脱ref
    // 2.通过数组的下标获取 => 不脱
    if (isRef(res)) {
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }
    // 访问的值仍是一个对象，对该对象再进行相应处理
    if (isObject(res)) {
      return isReadonly ? readonly(res) : reactive(res)
    }
    return res
  }
}

const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

// setter工厂函数
function createSetter(shallow = false) {
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    console.log('setter ', target, key, value)

    let oldValue = (target as any)[key]
    // readonly(ref({ xxx })) to noRef
    if (isReadonly(oldValue) && isRef(oldValue) && !isRef(value)) {
      return false
    }
    // 非shallow函数，新值不是只读
    if (!shallow && !isReadonly(value)) {
      // 新值不是shallow
      if (!isShallow(value)) {
        // 此时新值只能是 ref、reactive、raw
        // 新值toRaw之后只能是ref、raw，
        // 1.ref => ref     2.reactive、raw => raw
        value = toRaw(value)
        oldValue = toRaw(oldValue)
      }
      // value：shallowReactive shallowRef ref raw
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        // 1.老值是Ref 2.新值是reactive、raw、shallowReactive
        oldValue.value = value
        return true
      }
    } else {
      //
    }
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    if (target === toRaw(receiver)) {
      // 没有key是新增属性
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      }
      // 有key是改变属性
      else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

function deleteProperty(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  const result = Reflect.deleteProperty(target, key)
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

function ownKeys(target: object): (string | symbol)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

// reactive的处理函数
export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}

// readonly的处理函数，无法set和deleteProperty
export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set() {
    return true
  },
  deleteProperty() {
    return true
  }
}

export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
