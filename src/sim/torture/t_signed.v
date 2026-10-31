// Torture: signedness. Sign extension across widths, $signed/$unsigned,
// signed comparisons on odd widths, signed multiply and mixed expressions.
module t_signed (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [63:0] a,
    input  wire [63:0] b,
    input  wire [ 7:0] c,
    output reg  [31:0] ext5,
    output reg  [31:0] ext12,
    output reg  [63:0] ext28,
    output reg  [63:0] ext40,
    output reg  [ 7:0] cmp_odd,
    output reg  [ 7:0] cmp_wide,
    output reg  [23:0] smul,
    output reg  [47:0] smul48,
    output reg  [15:0] mixed,
    output reg  [ 9:0] absval,
    output reg  [31:0] sat,
    output wire [ 7:0] comb_cmp
);

  wire signed [ 4:0] s5 = a[4:0];
  wire signed [11:0] s12 = a[11:0];
  wire signed [27:0] s28 = a[27:0];
  wire signed [27:0] t28 = b[27:0];
  wire signed [39:0] s40 = a[39:0];
  wire signed [39:0] t40 = b[39:0];
  wire signed [ 9:0] s10 = b[9:0];
  wire signed [11:0] t12 = {c, 4'h8};

  assign comb_cmp = {
    s5 < 5'sd3, s12 > -12'sd100, s28 >= t28, s40 < t40, $signed(c) < 0, s10 <= -10'sd1, t12 > s12, 1'b1
  };

  always @(posedge clk) begin
    if (!rst_n) begin
      ext5 <= 0;
      ext12 <= 0;
      ext28 <= 0;
      ext40 <= 0;
      cmp_odd <= 0;
      cmp_wide <= 0;
      smul <= 0;
      smul48 <= 0;
      mixed <= 0;
      absval <= 0;
      sat <= 0;
    end else begin
      ext5 <= {{27{s5[4]}}, s5};
      ext12 <= 32'($signed(s12));
      ext28 <= 64'(s28);
      ext40 <= 64'(s40) + 64'(t40);
      cmp_odd <= {s5 < 0, s12 < 12'(s5), s28 < t28, s28 > t28, s12 <= -12'sd1, s5 >= -5'sd16, s28 == t28, s12 != 12'sd0};
      cmp_wide <= {s40 < t40, s40 > t40, s40 <= t40, s40 >= t40, s40 < 0, t40 > 0, $unsigned(s40) < $unsigned(t40), s40 == t40};
      smul <= 24'(s12 * t12);
      smul48 <= 48'(s28 * 48'(t28[19:0]));
      mixed <= 16'($signed(c) + s12);
      absval <= (s10 < 0) ? -s10 : s10;
      sat <= (s28 > 28'sd1000) ? 32'd1000 : (s28 < -28'sd1000) ? -32'd1000 : 32'(s28);
    end
  end

endmodule
