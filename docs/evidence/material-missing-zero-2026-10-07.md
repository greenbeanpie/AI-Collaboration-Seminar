# 项目材料评分缺失维度规则

材料评分先结合全部固定成果正文再次判断。存在直接或间接证据时给出数字分数、逐字引用和不确定性说明；全部成果完全未提及的维度按0分计入固定权重总分。服务端不猜测或自动把null转零：null、无证据正分、虚构引用反馈模型有界修正。低置信度真实证据不再导致材料分数被取消。

无可读正文仍先要求提取，不把未读取附件当作缺失。答辩、自由审阅及人工修正维持原规则。历史记录不改写，新材料评分使用独立v5提示词检查点。

修改文件：backend/src/services/assessments.ts、backend/test/102-project-simplification.test.ts、backend/test/145-material-missing-zero.test.ts。

验证：材料缺失维度、间接证据、null和无证据正分自动修正、虚构证据拒绝；项目评分与答辩回归；前端评分组件；类型检查、lint、构建、OpenAPI/typegen。未进行浏览器测试。发布记录见output/material-missing-zero-release.json。
