# Preview examples

## 数据处理流程

这是一组虚构的通用示例，用于展示图表和公式。

```mermaid
flowchart LR
    A[读取公开数据] --> B[检查格式]
    B --> C[清理空值]
    C --> D[计算统计量]
    D --> E[检查结果]
    E -->|需要调整| C
    E -->|完成| F[生成报告]
```

## 平均值

对一组数值计算算术平均值。

\[
\bar{x}=\frac{1}{n}\sum_{i=1}^{n}x_i
\]

## 方差

\[
\sigma^2=\frac{1}{n}\sum_{i=1}^{n}(x_i-\bar{x})^2
\]

## 二项式展开

\[
\begin{aligned}
(a+b)^2&=a^2+2ab+b^2\\
(a-b)^2&=a^2-2ab+b^2\\
(a+b)(a-b)&=a^2-b^2
\end{aligned}
\]
