import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'
import { ComputedRefImpl } from './computed'

type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

let effectTrackDepth = 0

export let trackOpBit = 1

const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

/**
 * 创建一个响应式的effect,用于扩展fn,使得当依赖的数据改变时,会重新执行
 */
export class ReactiveEffect<T = any> {
  active = true // 当前effect是否激活
  deps: Dep[] = [] // 记录依赖的属性
  parent: ReactiveEffect | undefined = undefined // 父级effect,解决effect嵌套
  computed?: ComputedRefImpl<T>
  allowRecurse?: boolean
  private deferStop?: boolean
  onStop?: () => void
  // DEV only
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void

  constructor(
    public fn: () => T,
    public scheduler: EffectScheduler | null = null,
    scope?: EffectScope
  ) {
    // 有scope才会执行
    recordEffectScope(this, scope)
  }

  run() {
    // 激活的effect才会收集依赖
    if (!this.active) {
      return this.fn()
    }
    let lastShouldTrack = shouldTrack
    // 此处用于处理嵌套effect，如果外层的effect中已经含有当前的effect,则当前effect不执行
    let parent: ReactiveEffect | undefined = activeEffect
    while (parent) {
      if (parent === this) {
        return
      }
      parent = parent.parent
    }
    // 开始执行fn并收集依赖，将activeEffect与依赖的属性关联起来
    try {
      // 保存上一个activeEffect
      this.parent = activeEffect
      // activeEffect设置为当前effect
      activeEffect = this
      shouldTrack = true
      // 每次执行fn前，需要清空之前的依赖，并重新收集依赖
      trackOpBit = 1 << ++effectTrackDepth
      // if (effectTrackDepth <= maxMarkerBits) {
      //   // 一些优化方案
      //   initDepMarkers(this)
      // } else {
      //   // 全量清空之前的依赖
      //   cleanupEffect(this)
      // }
      // 全量清空之前的依赖
      cleanupEffect(this)
      return this.fn()
    } finally {
      if (effectTrackDepth <= maxMarkerBits) {
        finalizeDepMarkers(this)
      }
      trackOpBit = 1 << --effectTrackDepth
      // 执行完成之后，回到上一个activeEffect
      activeEffect = this.parent
      shouldTrack = lastShouldTrack
      // 清空当前的parent
      this.parent = undefined
      if (this.deferStop) {
        this.stop()
      }
    }
  }

  stop() {
    if (activeEffect === this) {
      this.deferStop = true
    } else if (this.active) {
      cleanupEffect(this)
      if (this.onStop) {
        this.onStop()
      }
      this.active = false
    }
  }
}

function cleanupEffect(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

/**
 * Q:
 *   当存在effect嵌套时会出现问题!
 *   effect(() => {
 *     state.name        // name => e1, activeEffect = e1
 *     effect(() => {
 *       state.age       // age => e2, activeEffect = e2
 *     })
 *     state.other       // other => e1, activeEffect = ×
 *   })
 * A:
 *   老版本使用栈stack存放activeEffect,每次获取栈顶作为当前activeEffect
 *   activeEffect = this => stack.push(this)
 *   activeEffect = undefined => stack.pop()
 *
 *   新版本使用类似树结构存放activeEffect,增加parent属性指向父effect
 */

/**
 * effect
 * @param fn 执行的副作用,当状态改变时会重新执行
 */
export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  if ((fn as ReactiveEffectRunner).effect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }
  // 构造effect对象
  const _effect = new ReactiveEffect(fn)
  if (options) {
    extend(_effect, options)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  // 默认立即执行一次
  if (!options || !options.lazy) {
    _effect.run()
  }
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  runner.effect = _effect
  return runner
}

export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

export let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/**
 * 收集依赖
 */
export function track(target: object, type: TrackOpTypes, key: unknown) {
  debugger
  // 可以收集依赖，且存在activeEffect（不在effect中被访问的属性不收集）
  if (shouldTrack && activeEffect) {
    // 如何保存activeEffect与属性的关联关系?
    // WeakMap = { target: Map({ key: Set([effect]) }) }
    let depsMap = targetMap.get(target)
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }
    let dep = depsMap.get(key)
    if (!dep) {
      depsMap.set(key, (dep = createDep()))
    }
    const eventInfo = __DEV__
      ? { effect: activeEffect, target, type, key }
      : undefined
    trackEffects(dep, eventInfo)
  }
}

export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  debugger
  let shouldTrack = false
  if (effectTrackDepth <= maxMarkerBits) {
    if (!newTracked(dep)) {
      dep.n |= trackOpBit
      shouldTrack = !wasTracked(dep)
    }
  } else {
    // 一个effect里用了多次同一个属性,手动去重(性能)
    shouldTrack = !dep.has(activeEffect!)
  }
  if (shouldTrack) {
    dep.add(activeEffect!)
    // 保存该activeEffect所在的Set，到时需要清除
    activeEffect!.deps.push(dep)
    // if (__DEV__ && activeEffect!.onTrack) {
    //   activeEffect!.onTrack({
    //     effect: activeEffect!,
    //     ...debuggerEventExtraInfo!
    //   })
    // }
  }
}

/**
 * trigger 依赖的属性值更新,触发对应effect
 */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  debugger
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    return
  }
  let deps: (Dep | undefined)[] = []
  // collectionHandlers
  if (type === TriggerOpTypes.CLEAR) {
    deps = [...depsMap.values()]
  }
  // 触发key的是数组的length
  else if (key === 'length' && isArray(target)) {
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        deps.push(dep)
      }
    })
  } else {
    // void 0 === undefined
    // 比undefined长度短，且能保证值永远为undefined（undefined可能是个变量名）
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // 数组添加数组时，触发length的依赖
          deps.push(depsMap.get('length'))
        }
        break
      // collectionHandlers
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }
  // const eventInfo = __DEV__
  //   ? { target, type, key, newValue, oldValue, oldTarget }
  //   : undefined
  if (deps.length === 1) {
    if (deps[0]) {
      // if (__DEV__) {
      //   triggerEffects(deps[0], eventInfo)
      // } else {
      //   triggerEffects(deps[0])
      // }
      triggerEffects(deps[0])
    }
  } else {
    const effects: ReactiveEffect[] = []
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    // if (__DEV__) {
    //   triggerEffects(createDep(effects), eventInfo)
    // } else {
    //   triggerEffects(createDep(effects))
    // }
    triggerEffects(createDep(effects))
  }
}

export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  debugger
  const effects = isArray(dep) ? dep : [...dep]
  for (const effect of effects) {
    triggerEffect(effect, debuggerEventExtraInfo)
  }
  // for (const effect of effects) {
  //   if (effect.computed) {
  //     triggerEffect(effect, debuggerEventExtraInfo)
  //   }
  // }
  // for (const effect of effects) {
  //   if (!effect.computed) {
  //     triggerEffect(effect, debuggerEventExtraInfo)
  //   }
  // }
}

function triggerEffect(
  effect: ReactiveEffect,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // 当 effect 中存在修改依赖的属性的代码时,会无限调用 effect,需要屏蔽后续的 effect
  if (effect !== activeEffect || effect.allowRecurse) {
    // if (__DEV__ && effect.onTrigger) {
    //   effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
    // }
    // 有调度器则优先执行调度器
    if (effect.scheduler) {
      effect.scheduler()
    } else {
      effect.run()
    }
  }
}
