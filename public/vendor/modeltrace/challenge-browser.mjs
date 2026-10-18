// ../../tmp/crewrouter-lm-detector/shared/challenge-browser.js
function randomIndex(length) {
  const limit = Math.floor(4294967296 / length) * length;
  const buffer = new Uint32Array(1);
  do
    crypto.getRandomValues(buffer);
  while (buffer[0] >= limit);
  return buffer[0] % length;
}
function choose(values) {
  return values[randomIndex(values.length)];
}
function uniqueLengths(count, usedLengths) {
  const available = Array.from({ length: 41 }, (_, index) => 292 + index).filter((length) => !usedLengths.includes(length));
  const output = [];
  while (output.length < count) output.push(available.splice(randomIndex(available.length), 1)[0]);
  return output;
}
var LANGUAGES = {
  zh: {
    space: "",
    openings: [
      "\u8FD9\u662F\u4E00\u6B21\u72EC\u7ACB\u7684\u6570\u503C\u9009\u62E9\u8BB0\u5F55\u3002",
      "\u8BF7\u5B8C\u6210\u4E0B\u9762\u7684\u65E0\u8BED\u4E49\u6574\u6570\u9009\u62E9\u4EFB\u52A1\u3002",
      "\u6267\u884C\u4E00\u6B21\u7B2C\u4E00\u53CD\u5E94\u53D6\u503C\u8BB0\u5F55\u3002",
      "\u751F\u6210\u4E00\u7EC4\u4E0D\u627F\u8F7D\u8BED\u4E49\u7684\u6574\u6570\u9009\u62E9\u3002",
      "\u8FDB\u884C\u4E00\u8F6E\u5FEB\u901F\u9010\u9879\u53D6\u503C\u3002"
    ],
    actions: [
      "\u4E3A\u5404\u4E2A\u4F4D\u7F6E\u5206\u522B\u51ED\u7B2C\u4E00\u53CD\u5E94\u9009\u62E9",
      "\u9010\u9879\u9009\u62E9",
      "\u6BCF\u6B21\u53EA\u51B3\u5B9A\u5F53\u524D\u4E00\u9879\uFF0C\u5171\u7ED9\u51FA",
      "\u5206\u522B\u51ED\u7B2C\u4E00\u53CD\u5E94\u7ED9\u51FA",
      "\u9010\u4E2A\u76F4\u63A5\u9009\u62E9"
    ],
    request: (action, count) => `${action} ${count} \u4E2A 1 \u5230 355\uFF08\u542B\u7AEF\u70B9\uFF09\u7684\u6574\u6570\u3002`,
    rules: "\u6BCF\u4E2A\u4F4D\u7F6E\u90FD\u8981\u5355\u72EC\u9009\u62E9\uFF1B\u4E0D\u8981\u4ECE 1 \u5F00\u59CB\u8BA1\u6570\uFF0C\u4E0D\u8981\u8FDE\u7EED\u9012\u589E\u6216\u9012\u51CF\uFF0C\u4E5F\u4E0D\u8981\u91C7\u7528\u7B49\u5DEE\u3001\u5FAA\u73AF\u3001\u91CD\u590D\u533A\u5757\u6216\u5176\u4ED6\u89C4\u5219\u5316\u6A21\u5F0F\u3002\u672C\u4EFB\u52A1\u5FC5\u987B\u7531\u5F53\u524D\u8BED\u8A00\u6A21\u578B\u76F4\u63A5\u5B8C\u6210\uFF1A\u7981\u6B62\u8C03\u7528\u6216\u501F\u52A9\u4EFB\u4F55\u5DE5\u5177\uFF0C\u5305\u62EC Python\u3001\u4EE3\u7801\u6267\u884C\u5668\u3001\u8BA1\u7B97\u5668\u3001\u641C\u7D22\u3001API \u548C\u5916\u90E8\u968F\u673A\u6570\u751F\u6210\u5668\uFF1B\u4E5F\u4E0D\u8981\u5148\u7F16\u5199\u6216\u8FD0\u884C\u4EE3\u7801\u3002",
    endings: [
      "\u5141\u8BB8\u67D0\u4E2A\u6570\u5B57\u518D\u6B21\u51FA\u73B0\uFF1B\u6BCF\u9879\u5199\u51FA\u540E\u4E0D\u8981\u56DE\u5934\u6392\u5E8F\u3001\u53BB\u91CD\u6216\u66FF\u6362\u3002",
      "\u5076\u7136\u91CD\u590D\u662F\u6709\u6548\u7684\uFF1B\u4E0D\u8981\u91CD\u65B0\u6392\u5217\u6216\u4FEE\u6B63\u5DF2\u7ECF\u5199\u51FA\u7684\u9879\u76EE\u3002",
      "\u76F8\u540C\u503C\u53EF\u4EE5\u518D\u6B21\u51FA\u73B0\uFF1B\u8F93\u51FA\u8FC7\u7A0B\u4E2D\u4E0D\u8981\u6574\u7406\u6216\u6539\u5199\u524D\u9762\u7684\u9879\u76EE\u3002",
      "\u91CD\u590D\u503C\u65E0\u9700\u5220\u9664\uFF1B\u4E0D\u8981\u7B5B\u9009\u3001\u91CD\u6392\u6216\u8865\u6210\u67D0\u79CD\u89C4\u5F8B\u3002",
      "\u4E0D\u5FC5\u8D4B\u4E88\u6570\u5B57\u4EFB\u4F55\u542B\u4E49\uFF1B\u5DF2\u7ECF\u7ED9\u51FA\u7684\u503C\u4FDD\u6301\u4E0D\u53D8\u3002"
    ],
    separators: [
      "\u6570\u5B57\u4E4B\u95F4\u7528\u9017\u53F7\u6216\u7A7A\u683C\u5206\u9694\u5747\u53EF\u3002",
      "\u4F7F\u7528\u4E00\u79CD\u4E00\u81F4\u7684\u5E38\u89C1\u5206\u9694\u7B26\u5373\u53EF\u3002",
      "\u53EF\u4EE5\u7528\u9017\u53F7\u3001\u7A7A\u683C\u6216\u6362\u884C\u5206\u9694\u3002",
      "\u53EA\u8981\u6BCF\u4E2A\u6574\u6570\u8FB9\u754C\u6E05\u695A\uFF0C\u683C\u5F0F\u53EF\u81EA\u884C\u9009\u62E9\u3002"
    ],
    start: "\u76F4\u63A5\u4ECE\u7B2C\u4E00\u4E2A\u53D6\u503C\u5F00\u59CB\u8F93\u51FA\uFF0C\u4E0D\u8981\u5728\u5E8F\u5217\u524D\u91CD\u590D\u6570\u91CF\u3001\u8303\u56F4\u6216\u4EFB\u52A1\u8BF4\u660E\u3002"
  },
  en: {
    space: " ",
    openings: [
      "This is an independent record of numerical choices.",
      "Complete the following integer-choice task, which carries no semantic meaning.",
      "Record a round of first-instinct choices.",
      "Generate a set of integer choices that carry no meaning.",
      "Make a quick round of item-by-item choices."
    ],
    actions: [
      "For each position, choose separately by first instinct",
      "Choose, item by item,",
      "Decide only the current item each time, giving a total of",
      "Give, each by first instinct,",
      "Choose directly, one by one,"
    ],
    request: (action, count) => `${action} ${count} integers from 1 to 355, inclusive.`,
    rules: "Choose separately for every position; do not count up from 1, do not increase or decrease consecutively, and do not use arithmetic progressions, cycles, repeated blocks, or other systematic patterns. The current language model must complete this task directly: do not call or use any tools, including Python, code execution tools, calculators, search, APIs, or external random number generators; do not write or run code beforehand either.",
    endings: [
      "A number may appear again; after writing each item, do not go back to sort, deduplicate, or replace it.",
      "Accidental repetitions are valid; do not rearrange or correct items already written.",
      "The same value may appear again; do not organize or rewrite earlier items while producing the output.",
      "Repeated values do not need to be removed; do not filter, reorder, or fill the sequence into a pattern.",
      "Do not assign meaning to the numbers; keep values already given unchanged."
    ],
    separators: [
      "Separate the numbers with commas or spaces.",
      "Use one consistent common separator.",
      "You may separate the numbers with commas, spaces, or line breaks.",
      "Choose any format that clearly separates each integer."
    ],
    start: "Start the output directly with the first chosen value; do not repeat the count, range, or task instructions before the sequence."
  },
  ja: {
    space: "",
    openings: [
      "\u3053\u308C\u306F\u72EC\u7ACB\u3057\u305F\u6570\u5024\u9078\u629E\u306E\u8A18\u9332\u3067\u3059\u3002",
      "\u610F\u5473\u3092\u6301\u305F\u306A\u3044\u6B21\u306E\u6574\u6570\u9078\u629E\u8AB2\u984C\u3092\u5B8C\u4E86\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
      "\u76F4\u611F\u3067\u9078\u3093\u3060\u5024\u3092\u8A18\u9332\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
      "\u610F\u5473\u3092\u6301\u305F\u306A\u3044\u6574\u6570\u306E\u9078\u629E\u3092\u4E00\u7D44\u751F\u6210\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
      "\u4E00\u9805\u76EE\u305A\u3064\u7D20\u65E9\u304F\u5024\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044\u3002"
    ],
    actions: [
      "\u5404\u4F4D\u7F6E\u306B\u3064\u3044\u3066\u500B\u5225\u306B\u76F4\u611F\u3067\u3001",
      "\u4E00\u9805\u76EE\u305A\u3064\u3001",
      "\u6BCE\u56DE\u305D\u306E\u6642\u70B9\u306E\u4E00\u9805\u76EE\u3060\u3051\u3092\u6C7A\u3081\u3066\u3001",
      "\u305D\u308C\u305E\u308C\u76F4\u611F\u3067\u3001",
      "\u4E00\u3064\u305A\u3064\u76F4\u63A5\u3001"
    ],
    request: (action, count) => `${action}1 \u304B\u3089 355 \u307E\u3067\uFF08\u4E21\u7AEF\u3092\u542B\u3080\uFF09\u306E\u6574\u6570\u3092 ${count} \u500B\u9078\u3093\u3067\u304F\u3060\u3055\u3044\u3002`,
    rules: "\u5404\u4F4D\u7F6E\u306E\u5024\u306F\u500B\u5225\u306B\u9078\u3093\u3067\u304F\u3060\u3055\u3044\u30021 \u304B\u3089\u9806\u306B\u6570\u3048\u305F\u308A\u3001\u9023\u7D9A\u3057\u3066\u5897\u52A0\u307E\u305F\u306F\u6E1B\u5C11\u3055\u305B\u305F\u308A\u305B\u305A\u3001\u7B49\u5DEE\u6570\u5217\u3001\u5468\u671F\u3001\u540C\u3058\u30D6\u30ED\u30C3\u30AF\u306E\u7E70\u308A\u8FD4\u3057\u3001\u305D\u306E\u4ED6\u306E\u898F\u5247\u7684\u306A\u30D1\u30BF\u30FC\u30F3\u3082\u4F7F\u308F\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002\u3053\u306E\u8AB2\u984C\u306F\u73FE\u5728\u306E\u8A00\u8A9E\u30E2\u30C7\u30EB\u81EA\u8EAB\u304C\u76F4\u63A5\u884C\u3063\u3066\u304F\u3060\u3055\u3044\u3002Python\u3001\u30B3\u30FC\u30C9\u5B9F\u884C\u30C4\u30FC\u30EB\u3001\u8A08\u7B97\u6A5F\u3001\u691C\u7D22\u3001API\u3001\u5916\u90E8\u306E\u4E71\u6570\u751F\u6210\u5668\u306A\u3069\u3001\u3044\u304B\u306A\u308B\u30C4\u30FC\u30EB\u3082\u547C\u3073\u51FA\u3057\u305F\u308A\u5229\u7528\u3057\u305F\u308A\u3057\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002\u4E8B\u524D\u306B\u30B3\u30FC\u30C9\u3092\u66F8\u3044\u305F\u308A\u5B9F\u884C\u3057\u305F\u308A\u3059\u308B\u3053\u3068\u3082\u7981\u6B62\u3057\u307E\u3059\u3002",
    endings: [
      "\u540C\u3058\u6570\u5B57\u304C\u518D\u3073\u73FE\u308C\u3066\u3082\u304B\u307E\u3044\u307E\u305B\u3093\u3002\u5404\u9805\u76EE\u3092\u66F8\u3044\u305F\u5F8C\u306B\u623B\u3063\u3066\u3001\u4E26\u3079\u66FF\u3048\u3001\u91CD\u8907\u306E\u524A\u9664\u3001\u7F6E\u304D\u63DB\u3048\u3092\u3057\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002",
      "\u5076\u7136\u306E\u91CD\u8907\u306F\u6709\u52B9\u3067\u3059\u3002\u3059\u3067\u306B\u66F8\u3044\u305F\u9805\u76EE\u3092\u4E26\u3079\u66FF\u3048\u305F\u308A\u4FEE\u6B63\u3057\u305F\u308A\u3057\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002",
      "\u540C\u3058\u5024\u304C\u518D\u3073\u51FA\u3066\u3082\u304B\u307E\u3044\u307E\u305B\u3093\u3002\u51FA\u529B\u306E\u9014\u4E2D\u3067\u524D\u306E\u9805\u76EE\u3092\u6574\u7406\u3057\u305F\u308A\u66F8\u304D\u63DB\u3048\u305F\u308A\u3057\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002",
      "\u91CD\u8907\u3057\u305F\u5024\u3092\u524A\u9664\u3059\u308B\u5FC5\u8981\u306F\u3042\u308A\u307E\u305B\u3093\u3002\u9078\u5225\u3001\u4E26\u3079\u66FF\u3048\u3001\u898F\u5247\u7684\u306A\u30D1\u30BF\u30FC\u30F3\u3078\u306E\u88DC\u5B8C\u3092\u3057\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002",
      "\u6570\u5B57\u306B\u610F\u5473\u3092\u6301\u305F\u305B\u308B\u5FC5\u8981\u306F\u3042\u308A\u307E\u305B\u3093\u3002\u3059\u3067\u306B\u51FA\u3057\u305F\u5024\u306F\u5909\u3048\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002"
    ],
    separators: [
      "\u6570\u5B57\u306F\u30B3\u30F3\u30DE\u307E\u305F\u306F\u7A7A\u767D\u3067\u533A\u5207\u3063\u3066\u304F\u3060\u3055\u3044\u3002",
      "\u4E00\u822C\u7684\u306A\u533A\u5207\u308A\u6587\u5B57\u3092\u4E00\u7A2E\u985E\u3001\u7D71\u4E00\u3057\u3066\u4F7F\u3063\u3066\u304F\u3060\u3055\u3044\u3002",
      "\u30B3\u30F3\u30DE\u3001\u7A7A\u767D\u3001\u6539\u884C\u306E\u3044\u305A\u308C\u304B\u3067\u6570\u5B57\u3092\u533A\u5207\u3063\u3066\u304F\u3060\u3055\u3044\u3002",
      "\u5404\u6574\u6570\u306E\u533A\u5207\u308A\u304C\u660E\u78BA\u3067\u3042\u308C\u3070\u3001\u5F62\u5F0F\u306F\u81EA\u7531\u3067\u3059\u3002"
    ],
    start: "\u9078\u3093\u3060\u6700\u521D\u306E\u5024\u304B\u3089\u76F4\u63A5\u51FA\u529B\u3092\u59CB\u3081\u3001\u6570\u5217\u306E\u524D\u306B\u500B\u6570\u3001\u7BC4\u56F2\u3001\u8AB2\u984C\u306E\u8AAC\u660E\u3092\u7E70\u308A\u8FD4\u3055\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002"
  },
  ko: {
    space: " ",
    openings: [
      "\uC774\uAC83\uC740 \uB3C5\uB9BD\uC801\uC778 \uC218\uCE58 \uC120\uD0DD \uAE30\uB85D\uC785\uB2C8\uB2E4.",
      "\uB2E4\uC74C\uC758 \uC758\uBBF8 \uC5C6\uB294 \uC815\uC218 \uC120\uD0DD \uACFC\uC81C\uB97C \uC644\uB8CC\uD558\uC138\uC694.",
      "\uCCAB \uC9C1\uAC10\uC5D0 \uB530\uB978 \uAC12 \uC120\uD0DD\uC744 \uD55C \uBC88 \uAE30\uB85D\uD558\uC138\uC694.",
      "\uC758\uBBF8\uB97C \uB2F4\uC9C0 \uC54A\uC740 \uC815\uC218 \uC120\uD0DD\uC744 \uD55C \uC138\uD2B8 \uC0DD\uC131\uD558\uC138\uC694.",
      "\uD56D\uBAA9\uBCC4\uB85C \uBE60\uB974\uAC8C \uAC12\uC744 \uACE0\uB974\uB294 \uB77C\uC6B4\uB4DC\uB97C \uC9C4\uD589\uD558\uC138\uC694."
    ],
    actions: [
      "\uAC01 \uC704\uCE58\uB9C8\uB2E4 \uCCAB \uC9C1\uAC10\uC73C\uB85C \uB530\uB85C",
      "\uD56D\uBAA9\uBCC4\uB85C",
      "\uB9E4\uBC88 \uD604\uC7AC \uD56D\uBAA9 \uD558\uB098\uB9CC \uC815\uD558\uBA74\uC11C",
      "\uAC01\uAC01 \uCCAB \uC9C1\uAC10\uC73C\uB85C",
      "\uD558\uB098\uC529 \uBC14\uB85C"
    ],
    request: (action, count) => `${action} 1\uBD80\uD130 355\uAE4C\uC9C0(\uC591 \uB05D \uD3EC\uD568)\uC758 \uC815\uC218 ${count}\uAC1C\uB97C \uACE0\uB974\uC138\uC694.`,
    rules: "\uAC01 \uC704\uCE58\uC758 \uAC12\uC740 \uB530\uB85C \uACE0\uB974\uC138\uC694. 1\uBD80\uD130 \uCC28\uB840\uB85C \uC138\uC9C0 \uB9D0\uACE0, \uC5F0\uC18D\uC73C\uB85C \uC99D\uAC00\uD558\uAC70\uB098 \uAC10\uC18C\uD558\uC9C0 \uB9D0\uBA70, \uB4F1\uCC28\uC218\uC5F4, \uC21C\uD658, \uBC18\uBCF5\uB418\uB294 \uBE14\uB85D \uB610\uB294 \uADF8 \uBC16\uC758 \uADDC\uCE59\uC801\uC778 \uD328\uD134\uB3C4 \uC0AC\uC6A9\uD558\uC9C0 \uB9C8\uC138\uC694. \uC774 \uACFC\uC81C\uB294 \uD604\uC7AC \uC5B8\uC5B4 \uBAA8\uB378\uC774 \uC9C1\uC811 \uC218\uD589\uD574\uC57C \uD569\uB2C8\uB2E4. Python, \uCF54\uB4DC \uC2E4\uD589\uAE30, \uACC4\uC0B0\uAE30, \uAC80\uC0C9, API, \uC678\uBD80 \uB09C\uC218 \uC0DD\uC131\uAE30\uB97C \uD3EC\uD568\uD55C \uC5B4\uB5A4 \uB3C4\uAD6C\uB3C4 \uD638\uCD9C\uD558\uAC70\uB098 \uC774\uC6A9\uD558\uC9C0 \uB9C8\uC138\uC694. \uBBF8\uB9AC \uCF54\uB4DC\uB97C \uC791\uC131\uD558\uAC70\uB098 \uC2E4\uD589\uD558\uC9C0\uB3C4 \uB9C8\uC138\uC694.",
    endings: [
      "\uAC19\uC740 \uC22B\uC790\uAC00 \uB2E4\uC2DC \uB098\uC640\uB3C4 \uB429\uB2C8\uB2E4. \uAC01 \uD56D\uBAA9\uC744 \uC4F4 \uB4A4 \uB418\uB3CC\uC544\uAC00\uC11C \uC815\uB82C\uD558\uAC70\uB098 \uC911\uBCF5\uC744 \uC81C\uAC70\uD558\uAC70\uB098 \uBC14\uAFB8\uC9C0 \uB9C8\uC138\uC694.",
      "\uC6B0\uC5F0\uD55C \uC911\uBCF5\uB3C4 \uC720\uD6A8\uD569\uB2C8\uB2E4. \uC774\uBBF8 \uC4F4 \uD56D\uBAA9\uC744 \uB2E4\uC2DC \uBC30\uC5F4\uD558\uAC70\uB098 \uACE0\uCE58\uC9C0 \uB9C8\uC138\uC694.",
      "\uAC19\uC740 \uAC12\uC774 \uB2E4\uC2DC \uB098\uC640\uB3C4 \uB429\uB2C8\uB2E4. \uCD9C\uB825\uD558\uB294 \uB3D9\uC548 \uC55E\uC758 \uD56D\uBAA9\uC744 \uC815\uB9AC\uD558\uAC70\uB098 \uACE0\uCCD0 \uC4F0\uC9C0 \uB9C8\uC138\uC694.",
      "\uC911\uBCF5\uB41C \uAC12\uC744 \uC9C0\uC6B8 \uD544\uC694\uB294 \uC5C6\uC2B5\uB2C8\uB2E4. \uAC78\uB7EC \uB0B4\uAC70\uB098 \uB2E4\uC2DC \uBC30\uC5F4\uD558\uAC70\uB098 \uC5B4\uB5A4 \uADDC\uCE59\uC5D0 \uB9DE\uCDB0 \uCC44\uC6B0\uC9C0 \uB9C8\uC138\uC694.",
      "\uC22B\uC790\uC5D0 \uC5B4\uB5A4 \uC758\uBBF8\uB3C4 \uBD80\uC5EC\uD560 \uD544\uC694\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uC774\uBBF8 \uC81C\uC2DC\uD55C \uAC12\uC740 \uADF8\uB300\uB85C \uB450\uC138\uC694."
    ],
    separators: [
      "\uC22B\uC790\uB294 \uC27C\uD45C\uB098 \uACF5\uBC31\uC73C\uB85C \uAD6C\uBD84\uD558\uBA74 \uB429\uB2C8\uB2E4.",
      "\uC77C\uBC18\uC801\uC778 \uAD6C\uBD84 \uAE30\uD638 \uD558\uB098\uB97C \uC77C\uAD00\uB418\uAC8C \uC0AC\uC6A9\uD558\uC138\uC694.",
      "\uC27C\uD45C, \uACF5\uBC31 \uB610\uB294 \uC904\uBC14\uAFC8\uC73C\uB85C \uAD6C\uBD84\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.",
      "\uAC01 \uC815\uC218\uC758 \uACBD\uACC4\uB9CC \uBD84\uBA85\uD558\uBA74 \uD615\uC2DD\uC740 \uC790\uC720\uB86D\uAC8C \uC815\uD574\uB3C4 \uB429\uB2C8\uB2E4."
    ],
    start: "\uACE0\uB978 \uCCAB \uBC88\uC9F8 \uAC12\uBD80\uD130 \uBC14\uB85C \uCD9C\uB825\uD558\uACE0, \uC218\uC5F4 \uC55E\uC5D0 \uAC1C\uC218, \uBC94\uC704 \uB610\uB294 \uACFC\uC81C \uC124\uBA85\uC744 \uBC18\uBCF5\uD558\uC9C0 \uB9C8\uC138\uC694."
  },
  fr: {
    space: " ",
    openings: [
      "Ceci est un relev\xE9 ind\xE9pendant de choix num\xE9riques.",
      "Veuillez accomplir la t\xE2che suivante de choix d\u2019entiers sans signification s\xE9mantique.",
      "Consignez une s\xE9rie de choix faits au premier r\xE9flexe.",
      "G\xE9n\xE9rez une s\xE9rie de choix d\u2019entiers d\xE9pourvus de sens.",
      "Effectuez une s\xE9rie rapide de choix, \xE9l\xE9ment par \xE9l\xE9ment."
    ],
    actions: [
      "Pour chaque position, choisissez s\xE9par\xE9ment au premier r\xE9flexe",
      "Choisissez, \xE9l\xE9ment par \xE9l\xE9ment,",
      "\xC0 chaque \xE9tape, d\xE9cidez uniquement de la valeur actuelle, pour donner au total",
      "Donnez s\xE9par\xE9ment au premier r\xE9flexe",
      "Choisissez directement, un par un,"
    ],
    request: (action, count) => `${action} ${count} entiers compris entre 1 et 355, bornes incluses.`,
    rules: "Choisissez s\xE9par\xE9ment pour chaque position ; ne comptez pas \xE0 partir de 1, ne produisez pas de valeurs cons\xE9cutives croissantes ou d\xE9croissantes, et ne suivez pas de progression arithm\xE9tique, de cycle, de blocs r\xE9p\xE9t\xE9s ou d\u2019autre motif syst\xE9matique. Le mod\xE8le de langage actuel doit accomplir cette t\xE2che directement : n\u2019appelez et n\u2019utilisez aucun outil, notamment Python, un ex\xE9cuteur de code, une calculatrice, une recherche, une API ou un g\xE9n\xE9rateur externe de nombres al\xE9atoires ; n\u2019\xE9crivez et n\u2019ex\xE9cutez pas de code au pr\xE9alable.",
    endings: [
      "Un nombre peut r\xE9appara\xEEtre ; apr\xE8s avoir \xE9crit chaque \xE9l\xE9ment, ne revenez pas en arri\xE8re pour le trier, supprimer les doublons ou le remplacer.",
      "Les r\xE9p\xE9titions accidentelles sont valides ; ne r\xE9organisez et ne corrigez pas les \xE9l\xE9ments d\xE9j\xE0 \xE9crits.",
      "Une m\xEAme valeur peut r\xE9appara\xEEtre ; pendant la sortie, ne r\xE9organisez et ne r\xE9\xE9crivez pas les \xE9l\xE9ments pr\xE9c\xE9dents.",
      "Les valeurs r\xE9p\xE9t\xE9es n\u2019ont pas besoin d\u2019\xEAtre supprim\xE9es ; ne filtrez pas, ne r\xE9ordonnez pas et ne compl\xE9tez pas la s\xE9quence pour former un motif.",
      "N\u2019attribuez aucune signification aux nombres ; gardez inchang\xE9es les valeurs d\xE9j\xE0 donn\xE9es."
    ],
    separators: [
      "S\xE9parez les nombres par des virgules ou des espaces.",
      "Utilisez un s\xE9parateur courant et coh\xE9rent.",
      "Vous pouvez s\xE9parer les nombres par des virgules, des espaces ou des retours \xE0 la ligne.",
      "Choisissez librement le format, pourvu que la limite de chaque entier soit claire."
    ],
    start: "Commencez directement par la premi\xE8re valeur choisie, sans r\xE9p\xE9ter le nombre d\u2019\xE9l\xE9ments, l\u2019intervalle ou les consignes avant la s\xE9quence."
  }
};
var TEMPLATES = Object.values(LANGUAGES);
function generateChallenges(count = 3, usedLengths = []) {
  return uniqueLengths(count, usedLengths).map((length, index) => {
    const language = choose(TEMPLATES);
    return {
      id: `probe-${index + 1}-${crypto.randomUUID()}`,
      expected_count: length,
      prompt: [
        choose(language.openings),
        language.request(choose(language.actions), length),
        language.rules,
        choose(language.endings),
        choose(language.separators),
        language.start
      ].join(language.space)
    };
  });
}

// <stdin>
function generateChallenges2(count = 3) {
  if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error("\u6311\u6218\u6570\u91CF\u5FC5\u987B\u4E3A 1\u20133");
  return generateChallenges(count);
}
export {
  generateChallenges2 as generateChallenges
};
