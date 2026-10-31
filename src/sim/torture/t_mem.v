// Torture: memories. Byte/word/wide memories, 2-D arrays, initialized
// arrays (constant tables), case-based ROMs and read-during-write.
module t_mem (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [63:0] a,
    input  wire [63:0] b,
    input  wire [ 7:0] c,
    output reg  [ 7:0] rd8,
    output reg  [31:0] rd32,
    output reg  [63:0] rd64,
    output reg  [99:0] rd100,
    output reg  [ 5:0] rd2d,
    output reg  [ 7:0] rom_out,
    output reg  [15:0] sum_out,
    output wire [ 7:0] comb_rd,
    output wire [11:0] comb_rom
);

  reg [ 7:0] mem8  [0:63];
  reg [31:0] mem32 [16];
  reg [63:0] mem64 [0:7];
  reg [99:0] mem100[0:3];
  reg [ 5:0] mem2d [0:3][0:5];

  // constant table that verilator places in the constant pool
  wire [11:0] table12[0:15];
  assign table12[0]  = 12'h001;
  assign table12[1]  = 12'h0a3;
  assign table12[2]  = 12'h7ff;
  assign table12[3]  = 12'h800;
  assign table12[4]  = 12'h123;
  assign table12[5]  = 12'hfff;
  assign table12[6]  = 12'h555;
  assign table12[7]  = 12'haaa;
  assign table12[8]  = 12'h010;
  assign table12[9]  = 12'h020;
  assign table12[10] = 12'h040;
  assign table12[11] = 12'h080;
  assign table12[12] = 12'h100;
  assign table12[13] = 12'h200;
  assign table12[14] = 12'h400;
  assign table12[15] = 12'h3c3;
  assign comb_rom = table12[a[3:0]] ^ table12[b[7:4]];

  assign comb_rd = mem8[b[5:0]];

  integer i;

  function automatic [7:0] rom(input [3:0] addr);
    case (addr)
      4'd0: rom = 8'h3c;
      4'd1: rom = 8'h81;
      4'd2: rom = 8'h7e;
      4'd3: rom = 8'h00;
      4'd4: rom = 8'hff;
      4'd5: rom = 8'h18;
      4'd6: rom = 8'h24;
      4'd7: rom = 8'h42;
      4'd8: rom = 8'h99;
      4'd9: rom = 8'h66;
      4'd10: rom = 8'h5a;
      4'd11: rom = 8'ha5;
      default: rom = {4'h0, addr};
    endcase
  endfunction

  always @(posedge clk) begin
    if (!rst_n) begin
      for (i = 0; i < 64; i = i + 1) mem8[i] <= i[7:0] * 8'd3;
      for (i = 0; i < 16; i = i + 1) mem32[i] <= 32'hdead0000 | i;
      for (i = 0; i < 8; i = i + 1) mem64[i] <= {32'hcafe0000 | i, 32'h0};
      for (i = 0; i < 4; i = i + 1) mem100[i] <= 0;
      rd8 <= 0;
      rd32 <= 0;
      rd64 <= 0;
      rd100 <= 0;
      rd2d <= 0;
      rom_out <= 0;
      sum_out <= 0;
    end else begin
      mem8[a[5:0]] <= b[7:0];
      mem32[a[11:8]] <= b[31:0] ^ a[63:32];
      mem64[a[18:16]] <= mem64[a[18:16]] + b;
      mem100[c[1:0]] <= {a[35:0], b} + mem100[c[1:0]];
      mem2d[a[1:0]][b[2:0] % 6] <= c[5:0];
      rd8 <= mem8[c[5:0]];
      rd32 <= mem32[c[3:0]];
      rd64 <= mem64[c[2:0]];
      rd100 <= mem100[a[33:32]];
      rd2d <= mem2d[c[1:0]][c[4:2] % 6];
      rom_out <= rom(c[3:0]) ^ rom(a[7:4]);
      sum_out <= {8'd0, mem8[0]} + {8'd0, mem8[1]} + {8'd0, mem8[63]} + {8'd0, rd8};
    end
  end

endmodule
