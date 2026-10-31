// Torture: bit manipulation. Single-bit writes in loops, indexed part
// selects (+: / -:), packed 2-D arrays, replication, reductions, and
// generate blocks with submodule instances.
module t_bits_cell #(
    parameter integer W = 4,
    parameter [W-1:0] K = 0
) (
    input  wire [W-1:0] x,
    input  wire [W-1:0] y,
    output wire [W-1:0] z
);
  assign z = (x ^ K) + y;
endmodule

module t_bits (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [63:0] a,
    input  wire [63:0] b,
    input  wire [ 7:0] c,
    output reg  [31:0] scatter,
    output reg  [ 7:0] upsel,
    output reg  [ 7:0] downsel,
    output reg  [31:0] packed_out,
    output reg  [ 5:0] reductions,
    output reg  [47:0] repl,
    output reg  [63:0] setbits,
    output wire [15:0] gen_out,
    output wire [ 3:0] onehot_idx
);

  reg [3:0][7:0] packed2d;
  integer i;

  genvar g;
  generate
    for (g = 0; g < 4; g = g + 1) begin : cells
      t_bits_cell #(
          .W(4),
          .K(4'(g * 5))
      ) u_cell (
          .x(a[g*4+:4]),
          .y(b[g*4+:4]),
          .z(gen_out[g*4+:4])
      );
    end
  endgenerate

  // priority one-hot to index
  function automatic [3:0] oh2idx(input [15:0] v);
    integer k;
    begin
      oh2idx = 0;
      for (k = 0; k < 16; k = k + 1) if (v[k]) oh2idx = k[3:0];
    end
  endfunction
  assign onehot_idx = oh2idx(16'd1 << c[3:0]);

  always @(posedge clk) begin
    if (!rst_n) begin
      scatter <= 0;
      upsel <= 0;
      downsel <= 0;
      packed2d <= 0;
      packed_out <= 0;
      reductions <= 0;
      repl <= 0;
      setbits <= 64'hffff_0000_ffff_0000;
    end else begin
      for (i = 0; i < 32; i = i + 1) begin
        if (b[i]) scatter[i] <= a[i] ^ scatter[31-i];
      end
      upsel <= a[c[5:0]+:8];
      downsel <= b[{2'b0, c[5:0]}+8-:8];
      packed2d[c[1:0]] <= a[7:0];
      packed2d[c[3:2]][3:0] <= b[3:0];
      packed_out <= packed2d;
      reductions <= {&a[7:0], |b[15:0], ^a, ~&c, ~|b[7:0], ~^a[33:0]};
      repl <= {{3{c}}, {6{a[3:0]}}};
      setbits[c[5:0]] <= a[0];
      setbits[b[5:0]] <= ~setbits[b[5:0]];
    end
  end

endmodule
