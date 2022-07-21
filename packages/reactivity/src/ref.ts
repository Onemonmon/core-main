import {
  activeEffect,
  shouldTrack,
  trackEffects,
  triggerEffects
} from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import { isArray, hasChanged, IfAny } from '@vue/shared'
import { isProxy, toRaw, isReactive, toReactive } from './reactive'
import type { ShallowReactiveMarker } from './reactive'
import { CollectionTypes } from './collectionHandlers'
import { createDep, Dep } from './dep'

declare const RefSymbol: unique symbol
export declare const RawSymbol: unique symbol

export interface Ref<T = any> {
  value: T
  [RefSymbol]: true
}

type RefBase<T> = {
  dep?: Dep
  value: T
}

export function trackRefValue(ref: RefBase<any>) {
  if (shouldTrack && activeEffect) {
    ref = toRaw(ref)
    trackEffects(ref.dep || (ref.dep = createDep()))
    // if (__DEV__) {
    //   trackEffects(ref.dep || (ref.dep = createDep()), {
    //     target: ref,
    //     type: TrackOpTypes.GET,
    //     key: 'value'
    //   })
    // } else {
    //   trackEffects(ref.dep || (ref.dep = createDep()))
    // }
  }
}

export function triggerRefValue(ref: RefBase<any>, newVal?: any) {
  ref = toRaw(ref)
  if (ref.dep) {
    triggerEffects(ref.dep)
    // if (__DEV__) {
    //   triggerEffects(ref.dep, {
    //     target: ref,
    //     type: TriggerOpTypes.SET,
    //     key: 'value',
    //     newValue: newVal
    //   })
    // } else {
    //   triggerEffects(ref.dep)
    // }
  }
}

export function isRef<T>(r: Ref<T> | unknown): r is Ref<T>
export function isRef(r: any): r is Ref {
  return !!(r && r.__v_isRef === true)
}

export function ref<T extends object>(
  value: T
): [T] extends [Ref] ? T : Ref<UnwrapRef<T>>
export function ref<T>(value: T): Ref<UnwrapRef<T>>
export function ref<T = any>(): Ref<T | undefined>
export function ref(value?: unknown) {
  return createRef(value, false)
}

declare const ShallowRefMarker: unique symbol

export type ShallowRef<T = any> = Ref<T> & { [ShallowRefMarker]?: true }

export function shallowRef<T extends object>(
  value: T
): T extends Ref ? T : ShallowRef<T>
export function shallowRef<T>(value: T): ShallowRef<T>
export function shallowRef<T = any>(): ShallowRef<T | undefined>
export function shallowRef(value?: unknown) {
  return createRef(value, true)
}

/**
 * ref工厂函数
 */
function createRef(rawValue: unknown, shallow: boolean) {
  // 已经是ref，直接返回
  if (isRef(rawValue)) {
    return rawValue
  }
  // 创建一个ref实例对象
  return new RefImpl(rawValue, shallow)
}

/**
 * RefImpl
 */
class RefImpl<T> {
  private _value: T // 外部获取到的数据 xx.value
  private _rawValue: T // 原数据
  public dep?: Dep = undefined // 依赖该ref的effects
  public readonly __v_isRef = true

  constructor(value: T, public readonly __v_isShallow: boolean) {
    this._rawValue = __v_isShallow ? value : toRaw(value)
    // value是对象且不是shallow时，会自动转成reactive
    this._value = __v_isShallow ? value : toReactive(value)
  }
  // xx.value
  get value() {
    // 获取值时收集依赖
    trackRefValue(this)
    return this._value
  }
  // xx.value = xxx
  set value(newVal) {
    // 设置值（值改变了）时触发依赖
    newVal = this.__v_isShallow ? newVal : toRaw(newVal)
    if (hasChanged(newVal, this._rawValue)) {
      // 设置原数据
      this._rawValue = newVal
      // 设置.value的值
      this._value = this.__v_isShallow ? newVal : toReactive(newVal)
      triggerRefValue(this, newVal)
    }
  }
}

export function triggerRef(ref: Ref) {
  triggerRefValue(ref, __DEV__ ? ref.value : void 0)
}

export function unref<T>(ref: T | Ref<T>): T {
  return isRef(ref) ? (ref.value as any) : ref
}

const shallowUnwrapHandlers: ProxyHandler<any> = {
  get: (target, key, receiver) => unref(Reflect.get(target, key, receiver)),
  set: (target, key, value, receiver) => {
    const oldValue = target[key]
    if (isRef(oldValue) && !isRef(value)) {
      oldValue.value = value
      return true
    } else {
      return Reflect.set(target, key, value, receiver)
    }
  }
}
/**
 * 对象里存在ref时，访问时不需要.value
 * setup() {
 *    const name = ref("kaka")
 *    return { name }
 * }
 * 内部调用了proxyRefs，使用时直接name
 */
export function proxyRefs<T extends object>(
  objectWithRefs: T
): ShallowUnwrapRef<T> {
  return isReactive(objectWithRefs)
    ? objectWithRefs
    : new Proxy(objectWithRefs, shallowUnwrapHandlers)
}

export type CustomRefFactory<T> = (
  track: () => void,
  trigger: () => void
) => {
  get: () => T
  set: (value: T) => void
}

class CustomRefImpl<T> {
  public dep?: Dep = undefined

  private readonly _get: ReturnType<CustomRefFactory<T>>['get']
  private readonly _set: ReturnType<CustomRefFactory<T>>['set']

  public readonly __v_isRef = true

  constructor(factory: CustomRefFactory<T>) {
    const { get, set } = factory(
      () => trackRefValue(this),
      () => triggerRefValue(this)
    )
    this._get = get
    this._set = set
  }

  get value() {
    return this._get()
  }

  set value(newVal) {
    this._set(newVal)
  }
}

export function customRef<T>(factory: CustomRefFactory<T>): Ref<T> {
  return new CustomRefImpl(factory) as any
}

export type ToRefs<T = any> = {
  [K in keyof T]: ToRef<T[K]>
}

/**
 * toRefs将对象的所有属性值变为ref
 * 如果object本身不是响应式的，那么转换之后虽然是ref，但也不具备响应式
 */
export function toRefs<T extends object>(object: T): ToRefs<T> {
  // 建个外壳 [] {}
  const ret: any = isArray(object) ? new Array(object.length) : {}
  for (const key in object) {
    ret[key] = toRef(object, key)
  }
  return ret
}
// 类似proxy做了个代理，本身不提供响应式
class ObjectRefImpl<T extends object, K extends keyof T> {
  public readonly __v_isRef = true
  // data = {name: 'a', age: 12}
  constructor(
    private readonly _object: T,
    private readonly _key: K,
    private readonly _defaultValue?: T[K]
  ) {}
  // 获取name.value其实访问的是data.name，然后data.name自己收集依赖
  get value() {
    const val = this._object[this._key]
    return val === undefined ? (this._defaultValue as T[K]) : val
  }
  // 设置name.value其实就是给data.name赋值，然后触发data.name自己的依赖
  set value(newVal) {
    this._object[this._key] = newVal
  }
}

export type ToRef<T> = IfAny<T, Ref<T>, [T] extends [Ref] ? T : Ref<T>>

export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K
): ToRef<T[K]>

export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K,
  defaultValue: T[K]
): ToRef<Exclude<T[K], undefined>>

/**
 * toRef 将对象的某个属性值转成ref
 */
export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K,
  defaultValue?: T[K]
): ToRef<T[K]> {
  // 获取属性值
  const val = object[key]
  // 是ref直接返回，否则
  return isRef(val)
    ? val
    : (new ObjectRefImpl(object, key, defaultValue) as any)
}

type BaseTypes = string | number | boolean

export interface RefUnwrapBailTypes {}

export type ShallowUnwrapRef<T> = {
  [K in keyof T]: T[K] extends Ref<infer V>
    ? V
    : T[K] extends Ref<infer V> | undefined
    ? unknown extends V
      ? undefined
      : V | undefined
    : T[K]
}

export type UnwrapRef<T> = T extends ShallowRef<infer V>
  ? V
  : T extends Ref<infer V>
  ? UnwrapRefSimple<V>
  : UnwrapRefSimple<T>

export type UnwrapRefSimple<T> = T extends
  | Function
  | CollectionTypes
  | BaseTypes
  | Ref
  | RefUnwrapBailTypes[keyof RefUnwrapBailTypes]
  | { [RawSymbol]?: true }
  ? T
  : T extends Array<any>
  ? { [K in keyof T]: UnwrapRefSimple<T[K]> }
  : T extends object & { [ShallowReactiveMarker]?: never }
  ? {
      [P in keyof T]: P extends symbol ? T[P] : UnwrapRef<T[P]>
    }
  : T
