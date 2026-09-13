# Crown deformation

## 牙冠形变流程

从原始牙冠建立约束，检查实际间隙，再输出形变结果。

```mermaid
flowchart LR
    A[原牙冠与语义标记] --> B[确定可动区域和接触区]
    B --> C[查询真实表面并建立约束]
    C --> D[求解三阶平滑位移场]
    D --> E[检查翻折与实际间隙]
    E -->|仍有违反| C
    E -->|满足或预算耗尽| F[输出牙冠和测量报告]
```

## 位移能量

在原始牙冠上构造余切刚度矩阵 K 和表面质量矩阵 M。

\[
E(u)=\frac{1}{2}\sum_{a\in\{x,y,z\}}u_a^{\mathsf T}Hu_a
\]

## 平滑矩阵 H

\[
H=(K+M/\ell^2)M^{-1}(K+M/\ell^2)M^{-1}(K+M/\ell^2)
\]

## H 的展开式

\[
\begin{aligned}
H={}&KM^{-1}KM^{-1}K\\
 &+\frac{3}{\ell^2}KM^{-1}K\\
 &+\frac{3}{\ell^4}K+\frac{1}{\ell^6}M
\end{aligned}
\]
