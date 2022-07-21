import { DebuggerOptions, ReactiveEffect } from './effect'
import { Ref, trackRefValue, triggerRefValue } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'
import { Dep } from './dep'

declare const ComputedRefSymbol: unique symbol

export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
  [ComputedRefSymbol]: true
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (...args: any[]) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

/**
 * computed类
 * 1.computed内部使用的值改变时，computed的值要重新计算
 * 2.computed的值改变时，要触发对应的副作用
 */
export class ComputedRefImpl<T> {
  public dep?: Dep = undefined

  private _value!: T
  public readonly effect: ReactiveEffect<T>

  public readonly __v_isRef = true
  public readonly [ReactiveFlags.IS_READONLY]: boolean

  public _dirty = true // 标识computed值是否需要重新计算
  public _cacheable: boolean

  constructor(
    getter: ComputedGetter<T>,
    private readonly _setter: ComputedSetter<T>,
    isReadonly: boolean,
    isSSR: boolean
  ) {
    // computed本身具有副作用 => 1.
    this.effect = new ReactiveEffect(getter, () => {
      // getter内部使用的响应式变量改变时，会执行响应式变量的trigger
      // 响应式变量所触发的副作用是this.effect
      // 会触发this.effect的调度函数
      if (!this._dirty) {
        // 需要重新计算值
        this._dirty = true
        // 触发依赖该computed的副作用 => 2.
        triggerRefValue(this)
      }
    })
    this.effect.computed = this
    this.effect.active = this._cacheable = !isSSR
    this[ReactiveFlags.IS_READONLY] = isReadonly
  }
  // 当副作用里获取computed的value时，才会执行getter
  get value() {
    const self = toRaw(this)
    // 获取值的时候才会收集依赖
    trackRefValue(self)
    // 获取值并且_dirty=true时，才执行一次getter
    if (self._dirty || !self._cacheable) {
      self._dirty = false
      self._value = self.effect.run()!
    }
    return self._value
  }

  set value(newValue: T) {
    this._setter(newValue)
  }
}

export function computed<T>(
  getter: ComputedGetter<T>,
  debugOptions?: DebuggerOptions
): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions
): WritableComputedRef<T>

export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions,
  isSSR = false
) {
  let getter: ComputedGetter<T>
  // 没啥用
  let setter: ComputedSetter<T>
  // computed有两种写法
  // 1.computed({get(){return xxx}, set(){}})
  // 2.computed(()=>{return xxx})
  const onlyGetter = isFunction(getterOrOptions)
  // 转成成getter和setter
  if (onlyGetter) {
    getter = getterOrOptions
    setter = NOOP
  } else {
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }
  const cRef = new ComputedRefImpl(getter, setter, onlyGetter || !setter, isSSR)
  return cRef as any
}
