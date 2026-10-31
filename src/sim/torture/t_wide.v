// Torture: values wider than 64 bits. Arithmetic, bitwise, comparisons,
// concatenation, replication, variable part-selects and reductions.
module t_wide (
    input  wire         clk,
    input  wire         rst_n,
    input  wire [ 63:0] a,
    input  wire [ 63:0] b,
    input  wire [  7:0] c,
    output reg  [ 99:0] acc100,
    output reg  [ 99:0] sub100,
    output reg  [127:0] mul128,
    output reg  [199:0] cat200,
    output reg  [ 95:0] logic96,
    output reg  [ 15:0] cmp_flags,
    output reg  [  7:0] partsel,
    output reg  [ 31:0] word_from_wide,
    output reg  [ 65:0] neg66,
    output reg  [  2:0] reduce_flags,
    output wire [255:0] comb256,
    output wire [ 63:0] comb_down
);

  wire [127:0] x = {a, b};
  wire [127:0] y = {b ^ 64'h5555_aaaa_0f0f_f0f0, a + 64'd1};
  wire signed [127:0] sx = x;
  wire signed [127:0] sy = y;
  wire [255:0] big = {x, y};

  assign comb256 = {big[127:0], big[255:128]} ^ {4{a}};
  assign comb_down = big[c+:64];

  always @(posedge clk) begin
    if (!rst_n) begin
      acc100 <= 100'h1;
      sub100 <= 0;
      mul128 <= 0;
      cat200 <= 0;
      logic96 <= 0;
      cmp_flags <= 0;
      partsel <= 0;
      word_from_wide <= 0;
      neg66 <= 0;
      reduce_flags <= 0;
    end else begin
      acc100 <= acc100 + {36'd0, a} + {b[35:0], 64'd0};
      sub100 <= {a[35:0], b} - {b[35:0], a};
      mul128 <= x * {64'd0, b};
      cat200 <= {c, a, {2{b[31:0]}}, a[63:56], b[55:0]};
      logic96 <= ~({a[31:0], b} & {b[31:0], a}) | {3{c, 24'h00ff00}};
      cmp_flags <= {
        x == y,
        x != y,
        x < y,
        x > y,
        x <= y,
        x >= y,
        sx < sy,
        sx > sy,
        sx <= sy,
        sx >= sy,
        x == {b, a},
        big[255:128] == x,
        acc100 > {36'd0, a},
        (x & 128'h0) == 128'h0,
        x[127],
        y[0]
      };
      partsel <= big[c+:8];
      word_from_wide <= big[{c[2:0], 5'd0}+:32];
      neg66 <= -{a[1:0], b};
      reduce_flags <= {&x, |y, ^big};
    end
  end

endmodule
