// Torture: unsigned and signed arithmetic at many widths (8..64 bits),
// including division/modulo by zero (Verilator defines x/0 == 0).
module t_arith (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [63:0] a,
    input  wire [63:0] b,
    input  wire [ 7:0] c,
    output reg  [ 7:0] add8,
    output reg  [ 7:0] sub8,
    output reg  [15:0] mul16,
    output reg  [12:0] div13,
    output reg  [12:0] mod13,
    output reg  [31:0] add32,
    output reg  [31:0] mul32,
    output reg  [31:0] div32,
    output reg  [32:0] add33,
    output reg  [32:0] mul33,
    output reg  [47:0] sub48,
    output reg  [47:0] div48,
    output reg  [63:0] add64,
    output reg  [63:0] mul64,
    output reg  [63:0] div64,
    output reg  [63:0] mod64,
    output reg  [ 7:0] sdiv8,
    output reg  [ 7:0] smod8,
    output reg  [19:0] sdiv20,
    output reg  [19:0] smul20,
    output reg  [39:0] sdiv40,
    output reg  [39:0] smod40,
    output reg  [63:0] sdiv64,
    output reg  [ 5:0] small_div0,
    output wire [31:0] comb_mix
);

  wire signed [ 7:0] sa8 = a[7:0];
  wire signed [ 7:0] sb8 = {b[7:3], 3'b0};  // often divisible, sometimes 0
  wire signed [19:0] sa20 = a[19:0];
  wire signed [19:0] sb20 = b[19:0] >> c[3:0];
  wire signed [39:0] sa40 = a[39:0];
  wire signed [39:0] sb40 = b[39:0] >> c[5:0];
  wire signed [63:0] sa64 = a;
  wire signed [63:0] sb64 = b >> c[5:0];

  assign comb_mix = (a[31:0] * 32'd3) + (b[31:0] - {24'd0, c}) ^ (a[63:32] / {16'd0, b[15:0] | 16'd1});

  always @(posedge clk) begin
    if (!rst_n) begin
      add8 <= 0;
      sub8 <= 0;
      mul16 <= 0;
      div13 <= 0;
      mod13 <= 0;
      add32 <= 0;
      mul32 <= 0;
      div32 <= 0;
      add33 <= 0;
      mul33 <= 0;
      sub48 <= 0;
      div48 <= 0;
      add64 <= 0;
      mul64 <= 0;
      div64 <= 0;
      mod64 <= 0;
      sdiv8 <= 0;
      smod8 <= 0;
      sdiv20 <= 0;
      smul20 <= 0;
      sdiv40 <= 0;
      smod40 <= 0;
      sdiv64 <= 0;
      small_div0 <= 0;
    end else begin
      add8 <= a[7:0] + b[7:0] + c;
      sub8 <= a[7:0] - b[7:0];
      mul16 <= a[15:0] * b[15:0];
      div13 <= a[12:0] / b[12:0];
      mod13 <= a[12:0] % (b[12:0] >> c[3:0]);
      add32 <= a[31:0] + b[31:0];
      mul32 <= a[31:0] * b[31:0];
      div32 <= a[31:0] / (b[31:0] >> c[4:0]);
      add33 <= a[32:0] + b[32:0];
      mul33 <= a[32:0] * b[32:0];
      sub48 <= a[47:0] - b[47:0];
      div48 <= a[47:0] / (b[47:0] >> c[5:0]);
      add64 <= a + b;
      mul64 <= a * b;
      div64 <= a / (b >> c[5:0]);
      mod64 <= a % (b >> c[5:0]);
      sdiv8 <= sa8 / sb8;
      smod8 <= sa8 % sb8;
      sdiv20 <= sa20 / sb20;
      smul20 <= sa20 * sb20;
      sdiv40 <= sa40 / sb40;
      smod40 <= sa40 % sb40;
      sdiv64 <= sa64 / sb64;
      small_div0 <= a[5:0] / 6'd0 + a[5:0] % 6'd0;
    end
  end

endmodule
