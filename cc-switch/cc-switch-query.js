// cc-switch 用量查询脚本
// 将此内容粘贴到 cc-switch 的「自定义查询脚本」中即可
({
  request: {
    url: "{{baseUrl}}/api/user/usage",
    method: "POST",
    headers: {
      "Authorization": "Bearer {{apiKey}}",
      "User-Agent": "cc-switch/1.0"
    }
  },
  extractor: function(response) {
    if (response.error) {
      return {
        isValid: false,
        invalidMessage: response.error
      };
    }

    var result = {
      isValid: true,
      planName: response.username || "CrewRouter",
      unit: "balance"
    };

    // 用户组额度规则
    if (response.group && response.group.rules && response.group.rules.length > 0) {
      var lines = [];
      for (var i = 0; i < response.group.rules.length; i++) {
        var rule = response.group.rules[i];
        var typeLabel = rule.type === "requests" ? "请求" : "Token";
        var pct = rule.limit > 0 ? Math.round(rule.used / rule.limit * 100) : 0;
        lines.push(
          typeLabel + ": " + rule.used.toLocaleString() + " / " + rule.limit.toLocaleString()
          + " (" + pct + "%) / " + rule.window
        );
      }
      result.extra = lines.join("\n");

      // 用第一个规则作为主显示
      var primary = response.group.rules[0];
      result.total = primary.limit;
      result.used = primary.used;
      result.remaining = primary.remaining;
    }

    // 余额
    if (response.balance !== undefined) {
      result.extra = (result.extra ? result.extra + "\n" : "")
        + "余额: $" + response.balance.toFixed(4);
    }

    return result;
  }
})
