/**
 * Zhihuishu Bot - 选择器与行为配置
 * ---------------------------------------------------------------
 * 智慧树页面 DOM 会不定期改版，所以这里**所有选择器都是候选列表**，
 * 代码会按顺序逐个尝试，直到找到可用元素。
 *
 * 如果哪天扩展失效了，90% 的情况只需要修改本文件：
 *   1. 打开智慧树课程页，按 F12 用「元素选择器」点中目标元素
 *   2. 右键 -> Copy -> Copy selector，把结果加到对应数组的**最前面**
 *   3. 刷新页面即可生效（改完记得在 chrome://extensions 点「重新加载」）
 *
 * 注意：本文件同时被 content script 和 popup 读取，请保持纯 JS、无依赖。
 */
(function () {
  'use strict';

  /** 选择器配置：每个 key 都是一组候选选择器，按优先级从上到下尝试 */
  const SELECTORS = {
    /* ---------------- 页面识别 ---------------- */

    // 只在下列 host 上启用（留空表示不限制，由 manifest 的 matches 控制）
    hosts: [
      'studyh5.zhihuishu.com',
      'onlineweb.zhihuishu.com',
      'online.zhihuishu.com',
      'www.zhihuishu.com'
    ],

    // URL 中包含这些片段时，认为是「课程播放页」
    urlHints: [
      'videostudy',
      'studying',
      'video'
    ],

    /* ---------------- 视频元素 ---------------- */

    video: [
      '#vjs_container_html5_api',
      'video#vjs_video_1_html5_api',
      '#vjs_container video',
      '.vjs-tech',
      '.videoArea video',
      '#playBox video',
      '.prism-player video',
      '.prism-video video',
      '.video-box video',
      'video'
    ],

    // 播放区域容器：用于把自动点击限定在播放器范围内，避免误点页面其它地方
    videoContainer: [
      '#vjs_container',
      '.videoArea',
      '#playBox',
      '.prism-player',
      '.video-box',
      '.video-wrapper'
    ],

    /* ---------------- 播放 / 暂停 ---------------- */

    // 播放按钮（点击后开始播放）
    playButton: [
      '#playButton',
      '.vjs-big-play-button',
      '.bigPlayButton.pointer',
      '.bigPlayButton',
      '.vjs-play-control',
      '.prism-big-play-btn',
      '.prism-play-btn',
      '[class*="bigPlay"]',
      '[class*="playButton"]',
      '[class*="play-btn"]'
    ],

    /* ---------------- 下一节 / 下一集 ---------------- */

    nextButton: [
      '#nextBtn',
      '.nextBtn',
      '.next-btn',
      '.catalogue_next',
      '.video_next',
      '[class*="nextVideo"]',
      '[class*="next-video"]',
      '[class*="nextBtn"]',
      '[title*="下一"]',
      '[aria-label*="下一"]'
    ],

    // 文本兜底：找不到 class 时，扫描这些文字的可点击元素
    nextButtonTexts: [
      '下一节',
      '下一集',
      '下一讲',
      '下一视频',
      '下一个',
      '下一章'
    ],

    /* ---------------- 课程目录 ---------------- */

    catalog: [
      '#chapterList',
      '.catalogue-list',
      '.catalog-list',
      '.chapter-list',
      '.clearfix.catalogue_li',
      '.catalogue_li',
      '.catalogue'
    ],

    catalogItem: [
      '#chapterList li',
      '.catalogue-list li',
      '.catalogue_li li',
      '.chapter-item',
      '.catalog-item'
    ],

    // 目录中「当前正在播放」的条目
    catalogCurrent: [
      '.video.current_play',
      '.current_play',
      '.chapter-item.active',
      '.catalog-item.active',
      '.is-playing'
    ],

    /* ---------------- 课程标题 ---------------- */

    courseTitle: [
      '.course-name',
      '.courseName',
      '.videoTitle',
      '#courseName',
      '.source-title',
      '.title-text',
      '.video-title',
      'h1'
    ],

    /* ---------------- 弹题测验 ---------------- */

    // 弹题窗口的容器（多重候选，先看结构再看文字）
    quizDialog: [
      '.dialog-test',
      '.wrap_popboxes',
      '.wrap_popchapter',
      '.popboxes',
      '[class*="popboxes"]',
      '[class*="dialog-test"]',
      '[class*="examLayer"]',
      '[class*="question-box"]'
    ],

    // 只要弹窗内出现这些文字，就判定为弹题
    quizKeywords: [
      '弹题测验',
      '弹题',
      '【单选题】',
      '【多选题】',
      '【判断题】',
      '【填空题】'
    ],

    // 弹题窗口的关闭按钮
    quizCloseButton: [
      '.popbtn_cancel',
      '.popboxes_close',
      '.dialog-test .close',
      '.el-dialog__close',
      '.layui-layer-close',
      '[class*="popboxes"] .close'
    ],

    // 弹题窗口内的候选项（点它即可选中）
    quizOption: [
      '.topic-item',
      '.dialog-test .option',
      '[class*="popboxes"] .option',
      '[class*="option-item"]',
      '.answer-item',
      '.el-radio',
      '.el-checkbox'
    ],

    // 选项里真正的 input，某些实现需要点 input 才生效
    quizOptionInput: [
      'input[type="radio"]',
      'input[type="checkbox"]'
    ],

    // 弹题「下一题」按钮
    quizNextButton: [
      '.dialog-test .next',
      '.popbtn_next',
      '.popboxes_next',
      '[class*="next-question"]',
      '[class*="nextQuestion"]',
      '.swiper-button-next'
    ],
    quizNextTexts: ['下一题', '下一页', '下一'],

    // 弹题「提交 / 完成」按钮
    quizSubmitButton: [
      '.dialog-test .btn-primary',
      '.dialog-test .btn',
      '.popbtn_ok',
      '.popbtn_submit',
      '[class*="popboxes"] .btn-primary',
      '[class*="popboxes"] .btn'
    ],
    quizSubmitTexts: ['提交答案', '提交', '确定', '完成'],

    // 弹窗内只要出现这些字样，就认定为「正式考试」，自动作答立即停手
    quizExamKeywords: [
      '考试',
      '试卷',
      '期末',
      '期中',
      '补考',
      '重考',
      '成绩',
      '学分'
    ],

    /* ---------------- 普通提示 / 公告弹窗 ---------------- */

    noticeDialog: [
      '.el-dialog__wrapper',
      '.el-message-box',
      '.layui-layer-dialog',
      '.layui-layer',
      '.popboxes',
      '[class*="noticeBox"]',
      '[class*="notice-box"]',
      '[class*="tips-box"]'
    ],

    noticeCloseButton: [
      '.el-dialog__close',
      '.el-message-box__headerbtn',
      '.layui-layer-close',
      '.popboxes_close',
      '.dialog-close',
      '.close-btn',
      '.btn-close',
      '.close'
    ],

    // 只有按钮文字命中这些内容才会被点击（白名单机制）
    noticeCloseTexts: [
      '不再提示',
      '我知道了',
      '知道了',
      '我已知晓',
      '确定',
      '关闭'
    ],

    /* ---------------- 安全红线 ---------------- */

    // 出现这些文字的元素**永不点击**，防止误提交考试 / 退出课程
    forbiddenTexts: [
      '提交考试',
      '提交试卷',
      '提交作业',
      '考试结束',
      '结束考试',
      '交卷',
      '退出课程',
      '退出学习',
      '退出登录',
      '删除课程',
      '退课',
      '提交答案'
    ]
  };

  /** 时间与阈值配置：避免因为短暂卡顿就疯狂点击 */
  const TIMING = {
    // 主循环轮询间隔（毫秒）—— 定时轮询作为 MutationObserver 的兜底
    pollIntervalMs: 3000,

    // 检测到暂停后，等待多久才尝试点击播放
    playRetryDelayMs: 6000,

    // 单次「暂停」状态最多连续尝试播放几次，超过则退避
    maxPlayAttempts: 3,

    // 连续尝试失败后的退避时间
    playBackoffMs: 30000,

    // 点击「下一节」后，等待新视频加载的最长时间
    nextVideoWaitMs: 20000,

    // 判定「视频已结束」的容差（秒）：currentTime 距离 duration 小于该值即认为接近结束
    endedToleranceSec: 1.5,

    // 「已结束」状态持续多久才真正触发下一集（避免拖动进度条误判）
    endedConfirmMs: 2500,

    // 弹题出现后，自动操作暂停；弹题消失后多久恢复
    quizResumeDelayMs: 1500,

    // 自动作答时，每选中一个选项后的等待时间
    quizStepDelayMs: 500,

    // 点击「下一题」后的等待时间
    quizNextDelayMs: 900,

    // 点击「提交」后，等待弹窗关闭的时间
    quizSubmitDelayMs: 1500,

    // 同一道弹题最多重试作答的次数，避免死循环
    quizMaxRounds: 6,

    // 同一元素两次点击之间的最小间隔，防止连点
    clickCooldownMs: 1500,

    // 日志最大保留条数
    maxLogEntries: 200,

    // 是否在页面控制台打印日志
    debugToConsole: true
  };

  /** 运行状态枚举，供 popup 与 content 共用 */
  const STATE = {
    NO_PAGE: 'no_page',        // 未检测到课程页面
    NO_VIDEO: 'no_video',      // 有课程页但没找到视频
    PLAYING: 'playing',        // 正在播放
    PAUSED: 'paused',          // 已暂停
    ENDED: 'ended',            // 播放结束
    QUIZ: 'quiz',              // 检测到弹题
    WAITING_NEXT: 'waiting_next', // 等待下一集加载
    DISABLED: 'disabled'       // 功能全部关闭
  };

  const STATE_LABEL = {
    no_page: '未检测到课程页面',
    no_video: '未检测到课程视频',
    playing: '正在播放',
    paused: '已暂停',
    ended: '播放结束',
    quiz: '检测到弹题',
    waiting_next: '等待下一集',
    disabled: '已关闭'
  };

  /** 默认开关设置 */
  const DEFAULT_SETTINGS = {
    autoPlay: true,          // 自动播放
    autoNext: true,          // 自动下一集
    handleNotice: true,      // 普通弹窗处理
    autoAnswerQuiz: true,    // 自动作答弹题（开启后无需手动完成弹题）
    quizAnswerStrategy: 'smart' // 作答策略：smart=多选全选/其他选第一项 / first=选第一项 / all=全选 / random=随机
  };

  const SETTINGS_KEY = 'zhs_bot_settings';

  // 同时挂到 content script 的全局作用域与 popup 的全局作用域
  const api = { SELECTORS, TIMING, STATE, STATE_LABEL, DEFAULT_SETTINGS, SETTINGS_KEY };
  globalThis.ZHSBotConfig = api;
  if (typeof window !== 'undefined') window.ZHSBotConfig = api;
})();
