// Torture: scheduling. Negedge flops, async resets, derived (divided)
// clocks used as edges, combinational chains between always blocks,
// latch-style logic and blocking/non-blocking interplay.
module t_clocks (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [63:0] a,
    input  wire [63:0] b,
    input  wire [ 7:0] c,
    output reg  [15:0] pos_cnt,
    output reg  [15:0] neg_cnt,
    output reg  [15:0] div2_cnt,
    output reg  [15:0] div8_cnt,
    output reg  [ 7:0] async_q,
    output reg  [ 7:0] latch_q,
    output reg  [31:0] pipe_out,
    output reg  [ 7:0] swap_a,
    output reg  [ 7:0] swap_b,
    output wire [ 7:0] chain_out,
    output reg  [ 7:0] gated_cnt
);

  reg clk_div2;
  reg [2:0] div8;
  wire clk_div8 = div8[2];

  // divided clocks
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) clk_div2 <= 0;
    else clk_div2 <= ~clk_div2;
  end

  always @(posedge clk_div2 or negedge rst_n) begin
    if (!rst_n) div8 <= 0;
    else div8 <= div8 + 1;
  end

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) pos_cnt <= 0;
    else pos_cnt <= pos_cnt + {8'd0, c};
  end

  always @(negedge clk or negedge rst_n) begin
    if (!rst_n) neg_cnt <= 16'h1234;
    else neg_cnt <= neg_cnt ^ pos_cnt;
  end

  always @(posedge clk_div2 or negedge rst_n) begin
    if (!rst_n) div2_cnt <= 0;
    else div2_cnt <= div2_cnt + 1;
  end

  always @(posedge clk_div8 or negedge rst_n) begin
    if (!rst_n) div8_cnt <= 0;
    else div8_cnt <= div8_cnt + pos_cnt;
  end

  // asynchronous load from input when c[7] (acts like a second async control)
  wire async_load = rst_n & a[63] & c[7];
  always @(posedge clk or posedge async_load) begin
    if (async_load) async_q <= b[7:0];
    else async_q <= async_q + 1;
  end

  // latch inferred from combinational always (Verilator handles as comb)
  always @(*) begin
    if (c[0]) latch_q = a[7:0] ^ b[15:8];
    else latch_q = b[7:0];
  end

  // pipeline mixing blocking temporaries and non-blocking registers
  reg [31:0] stage1, stage2;
  reg [31:0] t;
  always @(posedge clk) begin
    t = a[31:0] + b[31:0];
    t = t ^ {t[15:0], t[31:16]};
    stage1 <= t;
    stage2 <= stage1 + {24'd0, latch_q};
    pipe_out <= stage2;
  end

  // non-blocking swap
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      swap_a <= 8'h0f;
      swap_b <= 8'hf0;
    end else if (c[1]) begin
      swap_a <= swap_b;
      swap_b <= swap_a;
    end
  end

  // combinational chain through several continuous assigns
  wire [7:0] w1 = pos_cnt[7:0] + neg_cnt[7:0];
  wire [7:0] w2 = w1 ^ div2_cnt[7:0];
  wire [7:0] w3 = {w2[6:0], w2[7]} + latch_q;
  assign chain_out = w3 & ~async_q;

  // gated clock: only toggles when enabled (clock = clk & en)
  reg en_latch;
  always @(negedge clk) en_latch <= c[2];
  wire gclk = clk & en_latch;
  always @(posedge gclk or negedge rst_n) begin
    if (!rst_n) gated_cnt <= 0;
    else gated_cnt <= gated_cnt + 1;
  end

endmodule
