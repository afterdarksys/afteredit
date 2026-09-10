import SampleCore
@inline(never) func runFixture() {
    var value = answer() - 1
    value += 1
    print(value)
}
runFixture()
