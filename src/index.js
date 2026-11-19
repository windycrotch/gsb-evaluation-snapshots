/*
 * @description:
 * @Author: ljc
 * @Date: 2021-07-13 14:22:35
 * @LastEditors: ljc
 * @LastEditTime: 2021-07-30 11:07:31
 */
import Vue from "vue";
import Play from "./canvasPlayer.vue";
import videoObj from "./data";
let Player = Vue.extend(Play);
let instance;
let seed = 1;

const component = (options) => {
  if (Vue.prototype.$isServer || seed !== 1) return;
  options = options || videoObj;
  instance = new Player({
    data: options,
  });
  instance.id = "player_" + seed++;
  instance.vm = instance.$mount();
  instance.dom = instance.vm.$el;
  document.body.appendChild(instance.dom);
  instance.dom.style.zIndex = seed + 1001;
  seed = 2;
  // 释放单例锁：组件销毁（beforeDestroy）时调用，使再次调用 $canvasVideoPlayer 能正常新建
  instance.vm.setFree = function () {
    seed = 1;
    instance = null;
  };
  return instance.vm;
};

export default {
  install: (Vue) => {
    Vue.prototype.$canvasVideoPlayer = component;
  },
};
