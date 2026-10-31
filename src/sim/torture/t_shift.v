// Torture: logical/arithmetic shifts by constant and variable amounts,
// including shift amounts >= width, on narrow, 64-bit and wide values.
module t_shift (
    input  wire         clk,
    input  wire         rst_n,
    input  wire [ 63:0] a,
    input  wire [ 63:0] b,
    input  wire [  7:0] c,
    output reg  [  6:0] shl7,
    output reg  [  6:0] shr7,
    output reg  [  6:0] sra7,
    output reg  [ 31:0] shl32,
    output reg  [ 31:0] shr32,
    output reg  [ 31:0] sra32,
    output reg  [ 39:0] shl40,
    output reg  [ 39:0] sra40,
    output reg  [ 63:0] shl64,
    output reg  [ 63:0] shr64,
    output reg  [ 63:0] sra64,
    output reg  [ 99:0] shl100,
    output reg  [ 99:0] shr100,
    output reg  [ 99:0] sra100,
    output reg  [ 99:0] shl100c,
    output reg  [ 99:0] sra100c,
    output wire [ 15:0] comb_shift,
    output wire [127:0] rot128
);

  wire signed [ 6:0] s7 = a[6:0];
  wire signed [31:0] s32 = a[31:0];
  wire signed [39:0] s40 = a[39:0];
  wire signed [63:0] s64 = a;
  wire [99:0] w100 = {a[35:0], b};
  wire signed [99:0] sw100 = {a[35:0], b};
  wire [127:0] w128 = {a, b};

  assign comb_shift = (a[15:0] << c[4:0]) | (b[15:0] >> c[7:4]);
  assign rot128 = (w128 << c[6:0]) | (w128 >> (8'd128 - {1'b0, c[6:0]}));

  always @(posedge clk) begin
    if (!rst_n) begin
      shl7 <= 0;
      shr7 <= 0;
      sra7 <= 0;
      shl32 <= 0;
      shr32 <= 0;
      sra32 <= 0;
      shl40 <= 0;
      sra40 <= 0;
      shl64 <= 0;
      shr64 <= 0;
      sra64 <= 0;
      shl100 <= 0;
      shr100 <= 0;
      sra100 <= 0;
      shl100c <= 0;
      sra100c <= 0;
    end else begin
      shl7 <= a[6:0] << c[3:0];
      shr7 <= a[6:0] >> c[3:0];
      sra7 <= s7 >>> c[3:0];
      shl32 <= a[31:0] << c[5:0];
      shr32 <= a[31:0] >> c[5:0];
      sra32 <= s32 >>> c[5:0];
      shl40 <= a[39:0] << c[5:0];
      sra40 <= s40 >>> c[5:0];
      shl64 <= a << c[6:0];
      shr64 <= a >> c[6:0];
      sra64 <= s64 >>> c[6:0];
      shl100 <= w100 << c;
      shr100 <= w100 >> c;
      sra100 <= sw100 >>> c;
      shl100c <= w100 << 37;
      sra100c <= sw100 >>> 71;
    end
  end

endmodule
